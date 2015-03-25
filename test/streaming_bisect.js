// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

/* HOWDO:
 *
 * Step 1: is there any failures to care about?
 *     $ node test/streaming_bisect.js
 *     ...
 *     # Isolated 4 failures
 *     # - head 31KiB + 965B body 64KiB
 *     # - head 431KiB + 1001B body 64KiB
 *     # - head 423KiB + 1023B body 128KiB
 *     # - head 437KiB + 17B body 512KiB
 *     ...
 *
 * Step 2: get detail on the first failure
 *     $ node test/streaming_bisect.js --trace --first
 *     ...
 *     # Failure #1: head 31KiB + 966B body 64KiB
 *     # Last good at: head 31KiB + 965B body 64KiB
 *     ... much detail ...
 *
 * Step 3: analyze the difference between good and bad
 *     $ NODE_DEBUG=tchannel,tchannel_dump node test/streaming_bisect.js \
 *         --repro --head '31KiB + 965B' --body '64KiB' --timeout 1000 2>&1 \
 *         | ./test/streaming_bisect_relabel.sh \
 *         >good
 *
 *     $ NODE_DEBUG=tchannel,tchannel_dump node test/streaming_bisect.js \
 *         --repro --head '31KiB + 966B' --body 64KiB --timeout 1000 2>&1 \
 *         | ./test/streaming_bisect_relabel.sh \
 *         >bad
 *
 *     $ diff -y good bad
 *     # or any other diff viewer
 */

var async = require('async');
var PassThrough = require('stream').PassThrough;
var test = require('tape');
var util = require('util');
var allocCluster = require('./lib/alloc-cluster.js');
var EndpointHandler = require('../endpoint-handler');
var CountStream = require('./lib/count_stream');
var TestIsolateSearch = require('./lib/test_isolate_search');
var base2 = require('./lib/base2');
var extend = require('xtend');

var argv = {
    first: false,
    trace: false,
    instrument: 0
};

if (require.main === module) {
    argv = require('minimist')(process.argv.slice(2), {
        boolean: {
            first: true,
            trace: true,
        },
        default: argv
    });
}

if (argv.repro) {
    var hSize = base2.parse(argv.head);
    var bSize = base2.parse(argv.body);
    if (isNaN(hSize)) die('invalid hSize');
    if (isNaN(bSize)) die('invalid hSize');
    var state = {
        hSize: hSize,
        bSize: bSize,
        timeout: argv.timeout
    };
    test.only('repro ' + describe(state), function t(assert) {
        var search = TestStreamSearch();
        var spec = search.makeSpec(state);
        search.test(spec, assert);
    });
}

test('bisection test', function t(assert) {
    var sizeLimit = null;

    if (argv.sizeLimit) {
        sizeLimit = base2.parse(argv.sizeLimit);
        if (isNaN(sizeLimit)) die('invalid sizeLimit');
    }

    var search = TestStreamSearch({
        stopOnFirstFailure: argv.first,
        traceDetails: argv.trace,
        sizeLimit: sizeLimit || 512 * base2.Ki,
        timeout: argv.timeout
    }).instrument(argv.instrument);

    var firstStop = {};

    async.series([

        {
            withHeaderOnly: true,
            withBodyOnly: true,
            withBoth: true,
            basis: [0, 1],
            mul: []
        },

        {
            withHeaderOnly: true,
            withBodyOnly: true,
            withBoth: true,
            basis: [2]
        },

        {
            withHeaderOnly: true,
            withBodyOnly: true,
            withBoth: true,
            basis: [3]
        },

        {
            // TODO: basis length >= 2 && withBoth causes non-deterministic
            // timeout failures (even with setting maxTries > 1); however none
            // of these failures are ever reproducible...
            // basis: [2, 3, 5, 7, 11, 13],
            withHeaderOnly: true,
            withBodyOnly: true,
            withBoth: false,
            basis: [2, 3],
            sizeLimit: sizeLimit || 128 * base2.Ki
        }

    ].map(function eachOptions(options) {
        return function runThunk(next) {
            search.run(assert, options, function(err, run) {
                if (!err && argv.first && run.fail) {
                    next(firstStop);
                } else {
                    next(err);
                }
            });
        };
    }), function done(err) {
        if (err && err !== firstStop) assert.ifError(err, 'no final error');
        assert.end();
    });
});

function TestStreamSearch(options) {
    if (!(this instanceof TestStreamSearch)) {
        return new TestStreamSearch(options);
    }
    var self = this;
    TestIsolateSearch.call(self, options);
}
util.inherits(TestStreamSearch, TestIsolateSearch);

TestStreamSearch.prototype.willFailLike = function willFailLike(a, b) {
    if (like(a, b)) return true;
    for (var i = 0; i < b.trace.length; i++) {
        var res = b.trace[i];
        if (res.fail && like(a, res.state)) return true;
    }
    return false;
    function like(a, b) {
        if (a.test.hSize !== b.test.hSize) return false;
        if (a.test.bSize < b.test.bSize) return false;
        return true;
    }
};

TestStreamSearch.prototype.describeState = function describeState(state) {
    return describe(state.test);
};

TestStreamSearch.prototype.describeNoFailure = function describeNoFailure(assert) {
    var self = this;
    assert.pass('found no failure under ' + prettyBytes(self.options.sizeLimit));
};

TestStreamSearch.prototype.init = function init() {
    var self = this;
    self.expand(function(_emit) {
        var base = {hSize: 0, bSize: 0, timeout: self.options.timeout};
        self.options.basis.forEach(function each(n) {
            if (self.options.withHeaderOnly) emit({hSize: n});
            if (self.options.withBodyOnly) emit({bSize: n});
            if (self.options.withBoth) emit({hSize: n, bSize: n});
        });
        function emit(overlay) {
            _emit(self.makeSpec(extend(base, overlay)));
        }
    });
};

TestStreamSearch.prototype.test = function test(state, assert) {
    var options = state.test;
    var name = describe(options);
    var cluster = allocCluster(2);
    cluster.ready(function clusterReady() {
        for (var i = 0; i < cluster.hosts.length; i++) {
            assert.comment(util.format(
                'cluster host %s: %s',
                i + 1, cluster.hosts[i]));
        }

        var one = cluster.channels[0];
        var two = cluster.channels[1];
        one.handler = echoHandler();
        assert.timeoutAfter(options.timeout || 100);
        assert.once('end', cluster.destroy);
        streamingTest({
            name: name,
            channel: two,
            opts: {host: cluster.hosts[0]},
            op: 'foo',
            headStream: CountStream({limit: options.hSize}),
            bodyStream: CountStream({limit: options.bSize})
        }, assert, function streamingTestDone() {
            var one = cluster.channels[0];
            var two = cluster.channels[1];
            var peersOne = one.getPeers();
            var peersTwo = two.getPeers();
            assert.equal(peersOne.length, 1, 'one should have 1 peer');
            assert.equal(peersTwo.length, 1, 'two should have 1 peer');
            var inPeer = peersOne[0];
            if (inPeer) {
                assert.equal(inPeer.direction, 'in', 'inPeer should be in');
                assert.equal(Object.keys(inPeer.inOps).length, 0, 'inPeer should have no inOps');
                assert.equal(Object.keys(inPeer.outOps).length, 0, 'inPeer should have no outOps');
            }
            var outPeer = peersTwo[0];
            if (outPeer) {
                assert.equal(outPeer.direction, 'out', 'outPeer should be out');
                assert.equal(Object.keys(outPeer.inOps).length, 0, 'outPeer should have no inOps');
                assert.equal(Object.keys(outPeer.outOps).length, 0, 'outPeer should have no outOps');
            }
            cluster.destroy(assert.end);
        });
    });
};

TestStreamSearch.prototype.explore = function explore(spec, _emit) {
    var self = this;
    var good = spec.good.test;
    (self.options.mul || self.options.basis).forEach(function each(n) {
        if (n < 2) return;
        var hSize = n * good.hSize;
        var bSize = n * good.bSize;
        if (hSize <= self.options.sizeLimit) emit({hSize: hSize});
        if (bSize <= self.options.sizeLimit) emit({bSize: bSize});
    });
    function emit(overlay) {
        _emit(spec.makeTest(extend(good, overlay)));
    }
};

TestStreamSearch.prototype.isolate = function isolate(spec, _emit) {
    var good = spec.good && spec.good.test || {hSize: 0, bSize: 0};
    var bad = spec.bad.test;
    if (bad.hSize - good.hSize > 1) emit({hSize: mid(good.hSize, bad.hSize)});
    if (good.bSize < bad.bSize) emit({bSize: mid(good.bSize, bad.bSize)});
    function emit(overlay) {
        _emit(spec.makeTest(extend(good, overlay)));
    }
    function mid(a, b) {
        return a + Math.floor(b / 2 - a / 2);
    }
};

function streamingTest(testCase, assert, callback) {
    if (!callback) callback = assert.end;

    var reqHeadStream;
    if (typeof testCase.headStream === 'function') {
        reqHeadStream = testCase.headStream();
    } else {
        reqHeadStream = testCase.headStream;
    }

    var reqBodyStream;
    if (typeof testCase.bodyStream === 'function') {
        reqBodyStream = testCase.bodyStream();
    } else {
        reqBodyStream = testCase.bodyStream;
    }

    var resHeadStream = PassThrough();
    var resBodyStream = PassThrough();

    var req = testCase.channel.request(testCase.opts);
    req.arg1.end(testCase.op);
    reqHeadStream.pipe(resHeadStream);
    reqHeadStream.pipe(req.arg2);
    req.arg2.once('finish', function onArg2Finished() {
        reqBodyStream.pipe(resBodyStream);
        reqBodyStream.pipe(req.arg3);
    });

    onResult.canStream = true;
    req.hookupCallback(onResult);

    function onResult(err, res) {
        assert.ifError(err, testCase.name + ': no result error');
        if (err) {
            callback();
            return;
        }
        async.series([
            verifyStream('arg2', res.arg2, resHeadStream),
            verifyStream('arg3', res.arg3, resBodyStream),
        ], callback);
    }

    function verifyStream(name, got, expected) {
        return function verifyStreamThunk(streamDone) {
            var offset = 0;
            got.on('data', onData);
            got.on('error', finish);
            got.on('end', finish);
            function onData(gotChunk) {
                var expectedChunk = expected.read(gotChunk.length);
                assert.deepEqual(gotChunk, expectedChunk, util.format(
                    '%s: expected chunk %s bytes @%s',
                    name,
                    prettyBytes(gotChunk.length),
                    '0x' + offset.toString(16))
                );
                offset += gotChunk.length;
            }
            function finish(err) {
                assert.ifError(err, name + ': no error');
                if (!err) {
                    var remain = expected.read();
                    assert.equal(remain, null, name + ': got all expected data (bytes)');
                    assert.equal(remain && remain.length || 0, 0, name + ': got all expected data (length)');
                }
                streamDone();
            }
        };
    }
}

function describe(params) {
    return util.format('head %s body %s',
        prettyBytes(params.hSize),
        prettyBytes(params.bSize));
}

function echoHandler() {
    var handler = EndpointHandler();
    function foo(req, res) {
        res.setOk(true);
        req.arg2.on('data', function onArg2Data(chunk) {
            res.arg2.write(chunk);
        });
        req.arg2.on('end', function onArg2End() {
            res.arg2.end();
        });

        req.arg3.on('data', function onArg3Data(chunk) {
            res.arg3.write(chunk);
        });
        req.arg3.on('end', function onArg3End() {
            res.arg3.end();
        });

    }
    foo.canStream = true;
    handler.register('foo', foo);
    return handler;
}

function die() {
    console.error.apply(console, arguments);
    process.exit(1);
}

function prettyBytes(n) {
    return base2.pretty(n, 'B');
}

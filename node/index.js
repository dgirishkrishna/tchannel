// Copyright (c) 2015 Uber Technologies, Inc.

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

var globalTimers = {
    setTimeout: require('timers').setTimeout,
    clearTimeout: require('timers').clearTimeout,
    now: Date.now
};
var globalRandom = Math.random;
var net = require('net');
var format = require('util').format;
var TypedError = require('error/typed');
var WrappedError = require('error/wrapped');
var extend = require('xtend');
var bufrw = require('bufrw');
var ChunkReader = require('bufrw/stream/chunk_reader');
var ChunkWriter = require('bufrw/stream/chunk_writer');
var reqres = require('./reqres');

var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var v2 = require('./v2');
var nullLogger = require('./null-logger.js');
var Spy = require('./v2/spy');
var EndpointHandler = require('./endpoint-handler.js');

var DEFAULT_OUTGOING_REQ_TIMEOUT = 2000;
var dumpEnabled = /\btchannel_dump\b/.test(process.env.NODE_DEBUG || '');

var TChannelListenError = WrappedError({
    type: 'tchannel.server.listen-failed',
    message: 'tchannel: {origMessage}',
    requestedPort: null,
    host: null
});

var TChannelReadProtocolError = WrappedError({
    type: 'tchannel.protocol.read-failed',
    message: 'tchannel read failure: {origMessage}',
    remoteName: null,
    localName: null
});

var NoHandlerError = TypedError({
    type: 'tchannel.no-handler',
    message: 'no handler defined'
});

var InvalidHandlerForRegister = TypedError({
    type: 'tchannel.invalid-handler.for-registration',
    message: 'Found unexpected handler when calling `.register()`.\n' +
        'You cannot set a custom handler when using `.register()`.\n' +
        '`.register()` is deprecated; use a proper handler.',
    handlerType: null,
    handler: null
});

var noHandlerHandler = {
    type: 'no-handler.handler',
    handleRequest: function noHandlerHandler(req, res) {
        res.sendNotOk(null, NoHandlerError().message);
    }
};

function TChannel(options) {
    if (!(this instanceof TChannel)) {
        return new TChannel(options);
    }

    var self = this;
    EventEmitter.call(self);

    self.options = extend({
        reqTimeoutDefault: 5000,
        serverTimeoutDefault: 5000,
        timeoutCheckInterval: 1000,
        timeoutFuzz: 100,
        // TODO: maybe we should always add pid to user-supplied?
        processName: format('%s[%s]', process.title, process.pid)
    }, options);

    self.logger = self.options.logger || nullLogger;

    // Filled in by the listen call:
    self.host = null;
    self.requestedPort = null;

    // Filled in by listening event:
    self.port = null;
    self.hostPort = null;
    self.random = self.options.random || globalRandom;
    self.timers = self.options.timers || globalTimers;

    // how to handle incoming requests
    self.handler = self.options.handler || noHandlerHandler;

    // populated by:
    // - manually api (.addPeer etc)
    // - incoming connections on any listening socket
    self.peers = Object.create(null);

    // TChannel advances through the following states.
    self.listened = false;
    self.listening = false;
    self.destroyed = false;

    // lazily created by .getServer (usually from .listen)
    self.serverSocket = null;
}
inherits(TChannel, EventEmitter);

TChannel.prototype.getServer = function getServer() {
    var self = this;
    if (self.serverSocket) return;
    self.serverSocket = net.createServer(function onServerSocketConnection(sock) {
        if (!self.destroyed) {
            var remoteAddr = sock.remoteAddress + ':' + sock.remotePort;
            var conn = new TChannelConnection(self, sock, 'in', remoteAddr);
            self.logger.debug('incoming server connection', {
                hostPort: self.hostPort,
                remoteAddr: conn.remoteAddr
            });
        }
    });
    self.serverSocket.on('listening', function onServerSocketListening() {
        if (!self.destroyed) {
            var address = self.serverSocket.address();
            self.hostPort = self.host + ':' + address.port;
            self.listening = true;
            self.logger.info(self.hostPort + ' listening');
            self.emit('listening');
        }
    });
    self.serverSocket.on('error', function onServerSocketError(err) {
        if (err.code === 'EADDRINUSE') {
            err = TChannelListenError(err, {
                requestedPort: self.requestedPort,
                host: self.host
            });
        }
        self.logger.error('server socket error', {
            err: err,
            requestedPort: self.requestedPort,
            host: self.host,
            hostPort: self.hostPort || null
        });
        self.emit('error', err);
    });
    self.serverSocket.on('close', function onServerSocketClose() {
        self.logger.warn('server socket close');
    });
    return self.serverSocket;
};

// Decoulping config and creation from the constructor.
TChannel.prototype.listen = function listen(port, host, callback) {
    var self = this;
    if (self.listened) {
        throw new Error('TChannel can only listen once'); // TODO typed error
    }
    if (typeof host !== 'string') {
        throw new Error('TChannel requires host argument'); // TODO typed error
    }
    if (typeof port !== 'number') {
        // Note that 0 is a valid port number, indicating that the system must
        // assign an available ephemeral port.
        throw new Error('TChannel must listen with numeric port'); // TODO typed error
    }
    // Does not expressly forbid 127.0.0.1 or localhost since these are valid
    // hosts for testing.
    if (host === '0.0.0.0') {
        throw new Error('TChannel must listen with externally visible host'); // TODO typed error
    }
    self.listened = true;
    self.requestedPort = port;
    self.host = host;
    self.getServer().listen(port, host, callback);
};

// TODO: deprecated, callers should use .handler directly
TChannel.prototype.register = function register(name, handler) {
    var self = this;

    var handlerType = self.handler && self.handler.type;

    switch (handlerType) {
        case 'no-handler.handler':
            // lazyily set up the legacy handler
            self.handler = EndpointHandler();
            self.handler.type = 'legacy-handler.handler';

            break;

        case 'legacy-handler.handler':
            // If its still the legacy handler then we are good.
            break;

        default:
            throw InvalidHandlerForRegister({
                handlerType: handlerType,
                handler: self.handler
            });
    }

    self.handler.register(name, onReqRes);

    function onReqRes(req, res, arg2, arg3) {
        handler(arg2, arg3, req.remoteAddr, onResponse);

        function onResponse(err, res1, res2) {
            if (err) {
                res.sendNotOk(res1, err.message);
            } else {
                res.sendOk(res1, res2);
            }
        }
    }
};

TChannel.prototype.address = function address() {
    var self = this;
    return self.serverSocket && self.serverSocket.address();
};

// not public, used by addPeer
TChannel.prototype.setPeer = function setPeer(hostPort, conn) {
    var self = this;
    if (hostPort === self.hostPort) {
        throw new Error('refusing to set self peer'); // TODO typed error
    }

    var list = self.peers[hostPort];
    if (!list) {
        list = self.peers[hostPort] = [];
    }

    if (conn.direction === 'out') {
        list.unshift(conn);
    } else {
        list.push(conn);
    }
    return conn;
};

TChannel.prototype.getPeer = function getPeer(hostPort) {
    var self = this;
    var list = self.peers[hostPort];
    return list && list[0] ? list[0] : null;
};

TChannel.prototype.removePeer = function removePeer(hostPort, conn) {
    var self = this;
    var list = self.peers[hostPort];
    var index = list ? list.indexOf(conn) : -1;

    if (index === -1) {
        return;
    }

    // TODO: run (don't walk) away from "arrays" as peers, get to actual peer
    // objects... note how these current semantics can implicitly convert
    // an in socket to an out socket
    list.splice(index, 1);
    if (!list.length) {
        delete self.peers[hostPort];
    }
};

TChannel.prototype.getPeers = function getPeers() {
    var self = this;
    var keys = Object.keys(self.peers);

    var peers = [];
    for (var i = 0; i < keys.length; i++) {
        var list = self.peers[keys[i]];

        for (var j = 0; j < list.length; j++) {
            peers.push(list[j]);
        }
    }

    return peers;
};

TChannel.prototype.addPeer = function addPeer(hostPort, connection) {
    var self = this;

    if (hostPort === self.hostPort) {
        throw new Error('refusing to add self peer'); // TODO typed error
    }

    if (!connection) {
        connection = self.makeOutConnection(hostPort);
    }

    var existingPeer = self.getPeer(hostPort);
    if (existingPeer !== null && existingPeer !== connection) { // TODO: how about === undefined?
        self.logger.warn('allocated a connection twice', {
            hostPort: hostPort,
            direction: connection.direction
            // TODO: more log context
        });
    }

    self.logger.debug('alloc peer', {
        source: self.hostPort,
        destination: hostPort,
        direction: connection.direction
        // TODO: more log context
    });
    connection.once('reset', function onConnectionReset(/* err */) {
        // TODO: log?
        self.removePeer(hostPort, connection);
    });
    connection.once('socketClose', function onConnectionSocketClose(conn, err) {
        self.emit('socketClose', conn, err);
    });
    return self.setPeer(hostPort, connection);
};

/* jshint maxparams:5 */
// TODO: deprecated, callers should use .request directly
TChannel.prototype.send = function send(options, arg1, arg2, arg3, callback) {
    var self = this;

    return self
        .request(options)
        .send(arg1, arg2, arg3, onResponse);

    function onResponse(err, res, arg2, arg3) {
        if (err) {
            return callback(err);
        }

        if (!res.ok) {
            return callback(new Error(String(arg3)));
        }

        return callback(null, arg2, arg3);
    }
};
/* jshint maxparams:4 */

TChannel.prototype.request = function request(options) {
    var self = this;
    if (self.destroyed) {
        throw new Error('cannot request() to destroyed tchannel'); // TODO typed error
    }

    var dest = options.host;
    if (!dest) {
        throw new Error('cannot request() without options.host'); // TODO typed error
    }

    var peer = self.getOutConnection(dest);
    return peer.request(options);
};

TChannel.prototype.getOutConnection = function getOutConnection(dest) {
    var self = this;
    var peer = self.getPeer(dest);
    if (!peer) {
        peer = self.addPeer(dest);
    }
    return peer;
};

TChannel.prototype.makeSocket = function makeSocket(dest) {
    var parts = dest.split(':');
    if (parts.length !== 2) {
        throw new Error('invalid destination'); // TODO typed error
    }
    var host = parts[0];
    var port = parts[1];
    if (host === '0.0.0.0' || port === '0') {
        throw new Error('cannot make out connection to ephemeral peer'); // TODO typed error
    }
    var socket = net.createConnection({host: host, port: port});
    return socket;
};

TChannel.prototype.makeOutConnection = function makeOutConnection(dest) {
    var self = this;
    var socket = self.makeSocket(dest);
    var connection = new TChannelConnection(self, socket, 'out', dest);
    return connection;
};

TChannel.prototype.quit = // to provide backward compatibility.
TChannel.prototype.close = function close(callback) {
    var self = this;

    if (self.destroyed) {
        throw new Error('double close'); // TODO typed error
    }

    self.destroyed = true;
    var peers = self.getPeers();
    var counter = peers.length + 1;

    self.logger.debug('quitting tchannel', {
        hostPort: self.hostPort
    });

    peers.forEach(function eachPeer(conn) {
        var sock = conn.socket;
        sock.once('close', onClose);

        conn.clearTimeoutTimer();

        self.logger.debug('destroy channel for', {
            direction: conn.direction,
            peerRemoteAddr: conn.remoteAddr,
            peerRemoteName: conn.remoteName,
            fromAddress: sock.address()
        });
        conn.resetAll(new Error('shutdown from quit')); // TODO typed error
        sock.destroy();
    });

    if (self.serverSocket) {
        if (self.serverSocket.address()) {
            closeServerSocket();
        } else {
            self.serverSocket.once('listening', closeServerSocket);
        }
    }

    function closeServerSocket() {
        self.serverSocket.once('close', onClose);
        self.serverSocket.close();
    }

    function onClose() {
        if (--counter <= 0) {
            if (counter < 0) {
                self.logger.error('closed more sockets than expected', {
                    counter: counter
                });
            }
            if (typeof callback === 'function') {
                callback();
            }
        }
    }
};

function TChannelConnection(channel, socket, direction, remoteAddr) {
    if (remoteAddr === channel.hostPort) {
        throw new Error('refusing to create self connection'); // TODO typed error
    }

    var self = this;
    EventEmitter.call(self);
    self.channel = channel;
    self.options = self.channel.options;
    self.logger = self.options.logger || nullLogger;
    self.random = self.options.random || globalRandom;
    self.timers = self.options.timers || globalTimers;
    self.socket = socket;
    self.direction = direction;
    self.remoteAddr = remoteAddr;
    self.timer = null;
    self.remoteName = null; // filled in by identify message

    // TODO: factor out an operation collection abstraction
    self.inOps = Object.create(null);
    self.inPending = 0;
    self.outOps = Object.create(null);
    self.outPending = 0;

    self.lastTimeoutTime = 0;
    self.closing = false;

    self.reader = ChunkReader(bufrw.UInt16BE, v2.Frame.RW);
    self.writer = ChunkWriter(v2.Frame.RW);
    self.handler = new v2.Handler(extend({
        hostPort: self.channel.hostPort
    }, self.options));

    // TODO: refactor op boundary to pass full req/res around
    self.handler.on('call.incoming.request', function onCallRequest(req) {
        self.handleCallRequest(req);
    });

    self.handler.on('call.incoming.response', function onCallResponse(res) {
        var op = self.popOutOp(res.id);
        if (!op) {
            self.logger.info('response received for unknown or lost operation', {
                responseId: res.id,
                remoteAddr: self.remoteAddr,
                direction: self.direction,
            });
            return;
        }
        op.req.emit('response', res);
    });

    self.handler.on('call.incoming.error', function onCallError(err) {
        var op = self.popOutOp(err.originalId);
        if (!op) {
            self.logger.info('error received for unknown or lost operation', err);
            return;
        }

        op.req.emit('error', err);
    });

    self.socket.setNoDelay(true);

    self.socket.on('error', function onSocketError(err) {
        self.onSocketErr(err);
    });
    self.socket.on('close', function onSocketClose() {
        self.onSocketErr(new Error('socket closed')); // TODO typed error
        if (self.remoteName === '0.0.0.0:0') {
            self.channel.removePeer(self.remoteAddr, self);
        }
    });

    self.reader.on('data', function onReaderFrame(frame) {
        self.onFrame(frame);
    });
    self.reader.on('error', function onReaderError(err) {
        self.onReaderError(err);
    });

    self.handler.on('error', function onHandlerError(err) {
        self.resetAll(err);
        // resetAll() does not close the socket
        self.socket.destroy();
    });

    if (direction === 'out') {
        self.handler.sendInitRequest();
        self.handler.once('init.response', function onOutIdentified(init) {
            self.remoteName = init.hostPort;
            self.channel.emit('identified', {
                hostPort: init.hostPort,
                processName: init.processName
            });
        });
    } else {
        self.handler.once('init.request', function onInIdentified(init) {
            self.remoteName = init.hostPort;
            self.channel.addPeer(init.hostPort, self);
            self.channel.emit('identified', {
                hostPort: init.hostPort,
                processName: init.processName
            });
        });
    }

    self.startTimeoutTimer();

    socket.once('close', clearTimer);

    var stream = self.socket;

    if (dumpEnabled) {
        stream = stream.pipe(Spy(process.stdout, {
            prefix: '>>> ' + self.remoteAddr + ' '
        }));
    }

    stream = stream
        .pipe(self.reader)
        .pipe(self.handler)
        .pipe(self.writer)
        ;

    if (dumpEnabled) {
        stream = stream.pipe(Spy(process.stdout, {
            prefix: '<<< ' + self.remoteAddr + ' '
        }));
    }

    stream = stream
        .pipe(self.socket)
        ;

    function clearTimer() {
        self.timers.clearTimeout(self.timer);
    }
}
inherits(TChannelConnection, EventEmitter);

TChannelConnection.prototype.onReaderError = function onReaderError(err) {
    var self = this;

    var readError = TChannelReadProtocolError(err, {
        remoteName: self.remoteName,
        localName: self.channel.hostPort
    });

    // TODO instead of resetting send an error frame first.
    // and reset the socket after sending an error frame
    self.resetAll(readError);
    // resetAll() does not close the socket
    self.socket.destroy();
};

// timeout check runs every timeoutCheckInterval +/- some random fuzz. Range is from
//   base - fuzz/2 to base + fuzz/2
TChannelConnection.prototype.getTimeoutDelay = function getTimeoutDelay() {
    var self = this;
    var base = self.options.timeoutCheckInterval;
    var fuzz = self.options.timeoutFuzz;
    return base + Math.round(Math.floor(self.random() * fuzz) - (fuzz / 2));
};

TChannelConnection.prototype.startTimeoutTimer = function startTimeoutTimer() {
    var self = this;
    self.timer = self.timers.setTimeout(function onChannelTimeout() {
        // TODO: worth it to clear the fired self.timer objcet?
        self.onTimeoutCheck();
    }, self.getTimeoutDelay());
};

TChannelConnection.prototype.clearTimeoutTimer = function clearTimeoutTimer() {
    var self = this;
    if (self.timer) {
        self.timers.clearTimeout(self.timer);
        self.timer = null;
    }
};

// If the connection has some success and some timeouts, we should probably leave it up,
// but if everything is timing out, then we should kill the connection.
TChannelConnection.prototype.onTimeoutCheck = function onTimeoutCheck() {
    var self = this;
    if (self.closing) {
        return;
    }

    if (self.lastTimeoutTime) {
        self.logger.warn(self.channel.hostPort + ' destroying socket from timeouts');
        self.socket.destroy();
        return;
    }

    self.checkOutOpsForTimeout(self.outOps);
    self.checkInOpsForTimeout(self.inOps);

    self.startTimeoutTimer();
};

TChannelConnection.prototype.checkInOpsForTimeout = function checkInOpsForTimeout(ops) {
    var self = this;
    var opKeys = Object.keys(ops);
    var now = self.timers.now();

    for (var i = 0; i < opKeys.length; i++) {
        var opKey = opKeys[i];
        var op = ops[opKey];

        if (op === undefined) {
            continue;
        }

        var timeout = self.options.serverTimeoutDefault;
        var duration = now - op.start;
        if (duration > timeout) {
            delete ops[opKey];
            self.inPending--;
        }
    }
};

TChannelConnection.prototype.checkOutOpsForTimeout = function checkOutOpsForTimeout(ops) {
    var self = this;
    var opKeys = Object.keys(ops);
    var now = self.timers.now();
    for (var i = 0; i < opKeys.length ; i++) {
        var opKey = opKeys[i];
        var op = ops[opKey];
        if (op.timedOut) {
            delete ops[opKey];
            self.outPending--;
            self.logger.warn('lingering timed-out outgoing operation');
            continue;
        }
        if (op === undefined) {
            // TODO: why not null and empty string too? I mean I guess false
            // and 0 might be a thing, but really why not just !op?
            self.channel.logger
                .warn('unexpected undefined operation', {
                    key: opKey,
                    op: op
                });
            continue;
        }
        var timeout = op.req.ttl || self.options.reqTimeoutDefault;
        var duration = now - op.start;
        if (duration > timeout) {
            delete ops[opKey];
            self.outPending--;
            self.onReqTimeout(op);
        }
    }
};

TChannelConnection.prototype.onReqTimeout = function onReqTimeout(op) {
    var self = this;
    op.timedOut = true;
    op.req.emit('error', new Error('timed out')); // TODO typed error
    // TODO: why don't we pop the op?
    self.lastTimeoutTime = self.timers.now();
};

// this socket is completely broken, and is going away
// In addition to erroring out all of the pending work, we reset the state in case anybody
// stumbles across this object in a core dump.
TChannelConnection.prototype.resetAll = function resetAll(err) {
    var self = this;
    if (self.closing) return;
    self.closing = true;

    var inOpKeys = Object.keys(self.inOps);
    var outOpKeys = Object.keys(self.outOps);

    self.logger[err ? 'warn' : 'info']('resetting connection', {
        error: err,
        remoteName: self.remoteName,
        localName: self.channel.hostPort,
        numInOps: inOpKeys.length,
        numOutOps: outOpKeys.length,
        inPending: self.inPending,
        outPending: self.outPending
    });

    self.clearTimeoutTimer();

    self.emit('reset', err);

    // requests that we've received we can delete, but these reqs may have started their
    //   own outgoing work, which is hard to cancel. By setting this.closing, we make sure
    //   that once they do finish that their callback will swallow the response.
    inOpKeys.forEach(function eachInOp(id) {
        // TODO: we could support an op.cancel opt-in callback
        delete self.inOps[id];
        // TODO report or handle or log errors or something
    });

    // for all outgoing requests, forward the triggering error to the user callback
    outOpKeys.forEach(function eachOutOp(id) {
        var op = self.outOps[id];
        delete self.outOps[id];
        // TODO: shared mutable object... use Object.create(err)?
        op.req.emit('error', err);
    });

    self.inPending = 0;
    self.outPending = 0;

    self.emit('socketClose', self, err);
};

TChannelConnection.prototype.onSocketErr = function onSocketErr(err) {
    var self = this;
    if (!self.closing) {
        self.resetAll(err);
    }
};

TChannelConnection.prototype.onFrame = function onFrame(/* frame */) {
    var self = this;
    if (!self.closing) {
        self.lastTimeoutTime = 0;
    }
};

TChannelConnection.prototype.popOutOp = function popOutOp(id) {
    var self = this;
    var op = self.outOps[id];
    if (!op) {
        // TODO else case. We should warn about an incoming response for an
        // operation we did not send out.  This could be because of a timeout
        // or could be because of a confused / corrupted server.
        return;
    }
    delete self.outOps[id];
    self.outPending--;
    return op;
};

// create a request
TChannelConnection.prototype.request = function request(options) {
    var self = this;
    // TODO: use this to protect against >4Mi outstanding messages edge case
    // (e.g. zombie operation bug, incredible throughput, or simply very long
    // timeout
    // if (self.outOps[id]) {
    //  throw new Error('duplicate frame id in flight'); // TODO typed error
    // }
    // TODO: provide some sort of channel default for "service"
    // TODO: generate tracing if empty?
    // TODO: refactor callers
    options.checksumType = options.checksum;

    // TODO: better default, support for dynamic
    options.ttl = options.timeout || DEFAULT_OUTGOING_REQ_TIMEOUT;
    var req = self.handler.buildOutgoingRequest(options);
    var id = req.id;
    self.outOps[id] = new TChannelClientOp(req, self.timers.now());
    self.pendingCount++;
    return req;
};

TChannelConnection.prototype.handleCallRequest = function handleCallRequest(req) {
    var self = this;
    req.remoteAddr = self.remoteName;
    var id = req.id;
    self.inPending++;
    var op = self.inOps[id] = new TChannelServerOp(self, self.timers.now(), req);
    process.nextTick(runHandler);

    function runHandler() {
        self.channel.handler.handleRequest(req, buildResponse);
    }

    function buildResponse(options) {
        if (op.res && op.res.state !== reqres.States.Initial) {
            throw new Error('response already built and started'); // TODO: typed error
        }
        op.res = self.handler.buildOutgoingResponse(req, options);
        op.res.once('finish', opDone);
        return op.res;
    }

    function opDone() {
        if (self.inOps[id] !== op) {
            self.logger.warn('mismatched opDone callback', {
                hostPort: self.channel.hostPort,
                opId: id
            });
            return;
        }
        delete self.inOps[id];
        self.inPending--;
    }
};

function TChannelServerOp(connection, start, req, res) {
    var self = this;
    self.req = req;
    self.res = res || null;
    self.connection = connection;
    self.logger = connection.logger;
    self.timedOut = false;
    self.start = start;
}

function TChannelClientOp(req, start) {
    var self = this;
    self.req = req;
    self.start = start;
    self.timedOut = false;
}

module.exports = TChannel;

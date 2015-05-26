# Copyright (c) 2015 Uber Technologies, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

from __future__ import absolute_import

import pytest
import tornado
import tornado.gen
from mock import patch

from tchannel.errors import ProtocolError
from tchannel.errors import TChannelError
from tchannel.errors import TimeoutError
from tchannel.messages import ErrorCode
from tchannel.theader import RetryType
from tchannel.tornado import Request
from tchannel.tornado import TChannel
from tchannel.tornado.peer import should_retry_on_error
from tchannel.tornado.stream import InMemStream


@pytest.mark.gen_test(timeout=10)
def test_retry_timeout():
    endpoint = b'tchannelretrytest'

    @tornado.gen.coroutine
    def handler_error(request, response, proxy):
        yield tornado.gen.sleep(3)
        response.connection.send_error(
            ErrorCode.busy,
            "retry",
            response.id,
        )
        # stop normal response streams
        response.set_exception(TChannelError("stop stream"))

    tchannel = TChannel()
    tchannel_server = None
    for i in range(5):
        tchannel_server = TChannel()
        tchannel_server.register(endpoint, 'raw', handler_error)
        tchannel_server.listen()
        tchannel.peers.get(tchannel_server.hostport)

    hostport = tchannel_server.hostport
    with (
        patch(
            'tchannel.tornado.peer.should_retry_on_error',
            autospec=True)
    ) as mock_should_retry_on_error:
        Request.TIMEOUT = 0.03
        mock_should_retry_on_error.return_value = True
        with pytest.raises(TimeoutError):
            yield tchannel.request(
                hostport,
                score_threshold=0,
            ).send(
                endpoint,
                "test",
                "test",
                headers={
                    're': RetryType.CONNECTION_ERROR_AND_TIMEOUT
                }
            )


@pytest.mark.gen_test
def test_retry_on_error_fail():
    endpoint = b'tchannelretrytest'

    @tornado.gen.coroutine
    def handler_error(request, response, proxy):
        response.connection.send_error(
            ErrorCode.busy,
            "retry",
            response.id,
        )

        # stop normal response streams
        response.set_exception(TChannelError("stop stream"))

    tchannel = TChannel()
    tchannel_server = None
    for i in range(5):
        tchannel_server = TChannel()
        tchannel_server.register(endpoint, 'raw', handler_error)
        tchannel_server.listen()
        tchannel.peers.get(tchannel_server.hostport)

    with (
        patch(
            'tchannel.tornado.peer.should_retry_on_error',
            autospec=True)
    ) as mock_should_retry_on_error:
        mock_should_retry_on_error.return_value = True
        with pytest.raises(ProtocolError) as e:
            yield tchannel.request(
                score_threshold=0
            ).send(
                endpoint,
                "test",
                "test",
                headers={
                    're': RetryType.TIMEOUT_AND_CONNECTION_ERROR
                }
            )

        assert mock_should_retry_on_error.called
        assert mock_should_retry_on_error.call_count == Request.MAX_RETRY_TIMES
        assert e.value.code == ErrorCode.busy


@pytest.mark.gen_test
def test_retry_on_error_success():

    endpoint = b'tchannelretrytest'

    @tornado.gen.coroutine
    def handler_success(request, response, proxy):
        response.set_body_s(InMemStream("success"))

    @tornado.gen.coroutine
    def handler_error(request, response, proxy):
        response.connection.send_error(
            ErrorCode.busy,
            "retry",
            response.id,
        )

        # stop normal response streams
        response.set_exception(TChannelError("stop stream"))

    tchannel = TChannel()
    tchannel_server = None
    for i in range(4):
        tchannel_server = TChannel()
        tchannel_server.register(endpoint, 'raw', handler_error)
        tchannel_server.listen()
        tchannel.peers.get(tchannel_server.hostport)

    tchannel_success = TChannel()
    tchannel_success.register(endpoint, 'raw', handler_success)
    tchannel_success.listen()
    tchannel.peers.get(tchannel_success.hostport)

    with (
        patch(
            'tchannel.tornado.peer.should_retry_on_error',
            autospec=True)
    ) as mock_should_retry_on_error:
        mock_should_retry_on_error.return_value = True
        response = yield tchannel.request(
            score_threshold=0
        ).send(
            endpoint,
            "test",
            "test",
            headers={
                're': RetryType.CONNECTION_ERROR_AND_TIMEOUT,
            }
        )

        header = yield response.get_header()
        body = yield response.get_body()
        assert body == "success"
        assert header == ""


@pytest.mark.gen_test
@pytest.mark.parametrize('retry_flag, error_code, result', [
    (RetryType.CONNECTION_ERROR, ErrorCode.busy, True),
    (RetryType.CONNECTION_ERROR, ErrorCode.declined, True),
    (RetryType.CONNECTION_ERROR, ErrorCode.timeout, False),
    (RetryType.TIMEOUT_AND_CONNECTION_ERROR, ErrorCode.timeout, True),
    (RetryType.TIMEOUT, ErrorCode.unexpected, False),
    (RetryType.TIMEOUT, ErrorCode.network_error, False),
    (RetryType.CONNECTION_ERROR, ErrorCode.network_error, True),
    (RetryType.NEVER, ErrorCode.network_error, False),
    (RetryType.CONNECTION_ERROR_AND_TIMEOUT, ErrorCode.cancelled, False),
    (RetryType.TIMEOUT_AND_CONNECTION_ERROR, ErrorCode.bad_request, False),

],
    ids=lambda arg: str(len(arg))
)
def test_should_retry_on_error(retry_flag, error_code, result):
    request = Request(
        headers={'re': retry_flag},
    )

    error = ProtocolError(code=error_code, description="retry")
    assert should_retry_on_error(request, error) == result

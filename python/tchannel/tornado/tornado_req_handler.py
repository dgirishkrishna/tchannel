import json
from tornado import httputil
from tornado.httputil import RequestStartLine
from ..req_handler import RequestHandler


class TornadoRequestHandler(RequestHandler):
    def __init__(self, app):
        self.request_callback = app

    def start_serving(self, request_conn):
        return _ServerRequestAdapter(self, request_conn)

    def handle_request(self, context, conn):
        """Handle incoming request

        :param context: incoming message context
        :param conn: incoming connection
        """
        request_delegate = self.start_serving(conn)
        message = context.message
        # process http message
        if message.headers["as"] == "http":
            method = "GET"
            if (hasattr(message, "arg_3") and
                    message.arg_3 is not None and
                    message.arg_3 != ""):
                method = "POST"

            start_line = RequestStartLine(method, message.arg_1, 'HTTP/1.1')
            try:
                headers = json.loads(message.arg_2)
            except:
                headers = {}

            body = message.arg_3 if hasattr(message, "arg_3") else ""
            request_delegate.headers_received(start_line, headers)
            request_delegate.data_received(body)
            request_delegate.finish()


class _ServerRequestAdapter():
    """Adapts the `TChannelMessageDelegate` interface to the interface expected
    by our clients.
    """
    def __init__(self, server, request_conn, server_conn=None):
        self.server = server
        self.connection = request_conn
        self.request = None
        if isinstance(server.request_callback,
                      httputil.HTTPServerConnectionDelegate):
            self.delegate = server.request_callback.start_request(
                server_conn, request_conn)
            self._chunks = None
        else:
            self.delegate = None
            self._chunks = []

    def headers_received(self, start_line, headers):
        # TODO implement xheaders
        if self.delegate is None:
            self.request = httputil.HTTPServerRequest(
                connection=self.connection, start_line=start_line,
                headers=headers)
        else:
            return self.delegate.headers_received(start_line, headers)

    def data_received(self, chunk):
        if self.delegate is None:
            self._chunks.append(chunk)
        else:
            return self.delegate.data_received(chunk)

    def finish(self):
        if self.delegate is None:
            self.request.body = b''.join(self._chunks)
            self.request._parse_body()
            self.server.request_callback(self.request)
        else:
            self.delegate.finish()
        self._cleanup()

    def on_connection_close(self):
        if self.delegate is None:
            self._chunks = None
        else:
            self.delegate.on_connection_close()
        self._cleanup()

    def _cleanup(self):
        # TODO cleanup work
        pass

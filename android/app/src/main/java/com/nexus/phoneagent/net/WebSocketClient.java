package com.nexus.phoneagent.net;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Minimal RFC 6455 WebSocket client with no third party dependency.
 *
 * Only "wss://" is used in practice (see Config.isWebSocketUrl), TLS hostname
 * verification is always performed, and certificate validation is never
 * disabled. Text frames only; ping/pong and close are handled.
 */
public final class WebSocketClient {

    private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private static final int OP_CONTINUATION = 0x0;
    private static final int OP_TEXT = 0x1;
    private static final int OP_BINARY = 0x2;
    private static final int OP_CLOSE = 0x8;
    private static final int OP_PING = 0x9;
    private static final int OP_PONG = 0xA;

    public interface Listener {
        void onOpen();

        void onTextMessage(String text);

        void onClosed(int code, String reason);

        void onError(String message, Throwable cause);
    }

    private final URI uri;
    private final Listener listener;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;
    private final int maxMessageBytes;
    private final SecureRandom random = new SecureRandom();
    private final Object writeLock = new Object();

    private volatile Socket socket;
    private volatile OutputStream output;
    private volatile boolean open;
    private Thread readerThread;

    public WebSocketClient(URI uri, Listener listener, int connectTimeoutMs, int readTimeoutMs, int maxMessageBytes) {
        this.uri = uri;
        this.listener = listener;
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        this.maxMessageBytes = maxMessageBytes;
    }

    public boolean isOpen() {
        return open && socket != null && !socket.isClosed();
    }

    /** Blocking connect. Call it from a background thread. */
    public void connect() throws IOException {
        String scheme = uri.getScheme();
        if (!"wss".equals(scheme) && !"ws".equals(scheme)) {
            throw new IOException("Only ws:// and wss:// endpoints are supported.");
        }
        String host = uri.getHost();
        if (host == null) {
            throw new IOException("The endpoint is missing a host.");
        }
        int port = uri.getPort() > 0 ? uri.getPort() : ("wss".equals(scheme) ? 443 : 80);
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        if (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty()) {
            path = path + "?" + uri.getRawQuery();
        }

        Socket plainSocket = new Socket();
        plainSocket.connect(new InetSocketAddress(host, port), connectTimeoutMs);

        Socket connected = plainSocket;
        if ("wss".equals(scheme)) {
            // Android declares SSLSocketFactory.getDefault() as returning
            // javax.net.SocketFactory; the object it hands back is an SSL
            // factory, so the cast is safe and the handshake below still runs.
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket ssl = (SSLSocket) factory.createSocket(plainSocket, host, port, true);
            enableSni(ssl, host);
            ssl.startHandshake();
            SSLSession session = ssl.getSession();
            if (!session.isValid()) {
                throw new IOException("TLS handshake produced an invalid session.");
            }
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)) {
                throw new IOException("The server certificate does not match " + host + ".");
            }
            connected = ssl;
        }

        connected.setSoTimeout(readTimeoutMs);
        connected.setTcpNoDelay(true);
        this.socket = connected;
        this.output = connected.getOutputStream();

        performHandshake(connected.getInputStream(), host, port, path);

        this.open = true;
        this.readerThread = new Thread(this::readLoop, "nexus-ws-reader");
        this.readerThread.setDaemon(true);
        this.readerThread.start();
        listener.onOpen();
    }

    private void enableSni(SSLSocket ssl, String host) {
        try {
            // setServerNames() requires API 24; on API 23 the platform falls back
            // to the default hostname, which is still verified above.
            javax.net.ssl.SSLParameters parameters = ssl.getSSLParameters();
            parameters.setServerNames(java.util.Collections.singletonList(
                    new javax.net.ssl.SNIHostName(host)));
            ssl.setSSLParameters(parameters);
        } catch (Throwable ignored) {
            // SNI is an optimisation, not a security control: verification still happens.
        }
    }

    private void performHandshake(InputStream input, String host, int port, String path) throws IOException {
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String key = Base64.encodeToString(nonce, Base64.NO_WRAP);

        String hostHeader = (port == 443 || port == 80) ? host : host + ":" + port;
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: NexusPhoneAgent/0.1\r\n\r\n";
        output.write(request.getBytes(StandardCharsets.US_ASCII));
        output.flush();

        String statusLine = readLine(input);
        if (statusLine == null || !statusLine.contains("101")) {
            throw new IOException("The server refused the WebSocket upgrade: " + statusLine);
        }

        String accept = null;
        String line;
        while ((line = readLine(input)) != null && !line.isEmpty()) {
            int separator = line.indexOf(':');
            if (separator <= 0) {
                continue;
            }
            String name = line.substring(0, separator).trim();
            String value = line.substring(separator + 1).trim();
            if ("Sec-WebSocket-Accept".equalsIgnoreCase(name)) {
                accept = value;
            }
        }

        String expected = acceptFor(key);
        if (accept == null || !expected.equals(accept)) {
            throw new IOException("The WebSocket handshake could not be verified.");
        }
    }

    private static String acceptFor(String key) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] hash = digest.digest((key + WEBSOCKET_GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.encodeToString(hash, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-1 is unavailable", e);
        }
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') {
                break;
            }
            if (value != '\r') {
                buffer.write(value);
            }
        }
        if (value == -1 && buffer.size() == 0) {
            return null;
        }
        return new String(buffer.toByteArray(), StandardCharsets.US_ASCII);
    }

    private void readLoop() {
        InputStream input = null;
        try {
            input = socket.getInputStream();
        } catch (IOException e) {
            fail("Could not open the socket input stream.", e);
            return;
        }

        ByteArrayOutputStream fragments = new ByteArrayOutputStream();
        int fragmentOpcode = OP_TEXT;

        try {
            while (open) {
                int first = input.read();
                if (first == -1) {
                    throw new IOException("The connection was closed by the server.");
                }
                int second = input.read();
                if (second == -1) {
                    throw new IOException("The connection was closed by the server.");
                }

                boolean fin = (first & 0x80) != 0;
                int opcode = first & 0x0F;
                boolean masked = (second & 0x80) != 0;
                long length = second & 0x7F;

                if (length == 126) {
                    length = ((long) readByte(input) << 8) | readByte(input);
                } else if (length == 127) {
                    long value = 0;
                    for (int i = 0; i < 8; i += 1) {
                        value = (value << 8) | readByte(input);
                    }
                    if (value < 0 || value > maxMessageBytes) {
                        throw new IOException("Oversized frame: " + value + " bytes.");
                    }
                    length = value;
                }

                if (length > maxMessageBytes) {
                    throw new IOException("Oversized frame: " + length + " bytes.");
                }
                if (masked) {
                    throw new IOException("Server frames must not be masked.");
                }

                byte[] payload = readFully(input, (int) length);

                switch (opcode) {
                    case OP_CONTINUATION:
                        fragments.write(payload);
                        if (fin) {
                            deliver(fragmentOpcode, fragments.toByteArray());
                            fragments.reset();
                        }
                        break;
                    case OP_TEXT:
                    case OP_BINARY:
                        if (fin) {
                            deliver(opcode, payload);
                        } else {
                            fragmentOpcode = opcode;
                            fragments.reset();
                            fragments.write(payload);
                        }
                        break;
                    case OP_PING:
                        sendFrame(OP_PONG, payload);
                        break;
                    case OP_PONG:
                        break;
                    case OP_CLOSE:
                        close(1000, "closed by server");
                        return;
                    default:
                        throw new IOException("Unsupported opcode: " + opcode);
                }
            }
        } catch (IOException e) {
            if (open) {
                fail("The connection was lost: " + e.getMessage(), e);
            }
        }
    }

    private void deliver(int opcode, byte[] payload) {
        if (opcode != OP_TEXT) {
            return;
        }
        listener.onTextMessage(new String(payload, StandardCharsets.UTF_8));
    }

    private static int readByte(InputStream input) throws IOException {
        int value = input.read();
        if (value == -1) {
            throw new IOException("Truncated frame header.");
        }
        return value & 0xFF;
    }

    private static byte[] readFully(InputStream input, int length) throws IOException {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(buffer, offset, length - offset);
            if (read == -1) {
                throw new IOException("Truncated frame payload.");
            }
            offset += read;
        }
        return buffer;
    }

    /** Send a text frame. Safe to call from any thread. */
    public boolean send(String text) {
        if (text == null) {
            return false;
        }
        return sendFrame(OP_TEXT, text.getBytes(StandardCharsets.UTF_8));
    }

    private boolean sendFrame(int opcode, byte[] payload) {
        if (!isOpen()) {
            return false;
        }
        int length = payload.length;
        int headerLength = 2 + (length <= 125 ? 0 : length <= 65535 ? 2 : 8) + 4;
        byte[] frame = new byte[headerLength + length];
        frame[0] = (byte) (0x80 | opcode);

        int maskOffset;
        if (length <= 125) {
            frame[1] = (byte) (0x80 | length);
            maskOffset = 2;
        } else if (length <= 65535) {
            frame[1] = (byte) (0x80 | 126);
            frame[2] = (byte) ((length >> 8) & 0xFF);
            frame[3] = (byte) (length & 0xFF);
            maskOffset = 4;
        } else {
            frame[1] = (byte) (0x80 | 127);
            for (int i = 0; i < 8; i += 1) {
                frame[2 + i] = (byte) ((((long) length) >> (8 * (7 - i))) & 0xFF);
            }
            maskOffset = 10;
        }

        byte[] mask = new byte[4];
        random.nextBytes(mask);
        System.arraycopy(mask, 0, frame, maskOffset, 4);
        for (int i = 0; i < length; i += 1) {
            frame[maskOffset + 4 + i] = (byte) (payload[i] ^ mask[i % 4]);
        }

        synchronized (writeLock) {
            if (!isOpen()) {
                return false;
            }
            try {
                output.write(frame);
                output.flush();
                return true;
            } catch (IOException e) {
                fail("Could not send a message: " + e.getMessage(), e);
                return false;
            }
        }
    }

    public void close(int code, String reason) {
        if (!open) {
            return;
        }
        open = false;
        try {
            byte[] body = new byte[2 + (reason == null ? 0 : reason.length())];
            body[0] = (byte) ((code >> 8) & 0xFF);
            body[1] = (byte) (code & 0xFF);
            if (reason != null) {
                System.arraycopy(reason.getBytes(StandardCharsets.UTF_8), 0, body, 2, reason.length());
            }
            sendFrameRaw(OP_CLOSE, body);
        } catch (Exception ignored) {
            // Closing: nothing useful to do if the close frame cannot be written.
        }
        shutdown();
        listener.onClosed(code, reason == null ? "" : reason);
    }

    /** Masked control frame; used for the close handshake. */
    private void sendFrameRaw(int opcode, byte[] payload) throws IOException {
        synchronized (writeLock) {
            if (output == null) {
                return;
            }
            byte[] mask = new byte[4];
            random.nextBytes(mask);
            byte[] frame = new byte[2 + 4 + payload.length];
            frame[0] = (byte) (0x80 | opcode);
            frame[1] = (byte) (0x80 | payload.length);
            System.arraycopy(mask, 0, frame, 2, 4);
            for (int i = 0; i < payload.length; i += 1) {
                frame[6 + i] = (byte) (payload[i] ^ mask[i % 4]);
            }
            output.write(frame);
            output.flush();
        }
    }

    private void fail(String message, Throwable cause) {
        open = false;
        shutdown();
        listener.onError(message, cause);
    }

    private void shutdown() {
        try {
            if (socket != null && !socket.isClosed()) {
                socket.close();
            }
        } catch (IOException ignored) {
            // Already closing.
        }
    }
}

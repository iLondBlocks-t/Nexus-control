package com.nexus.phoneagent.net;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

/**
 * Redeems a pairing code for a device token.
 *
 * Only https:// is accepted, the token is returned once by the server and is
 * written straight into the encrypted-by-the-platform credential store by the
 * caller. Nothing is logged.
 */
public final class PairingClient {

    private static final int TIMEOUT_MS = 15000;

    public static final class Result {
        public final boolean ok;
        public final String errorCode;
        public final String message;
        public final String deviceId;
        public final String deviceToken;
        public final String webSocketUrl;

        private Result(boolean ok, String errorCode, String message, String deviceId,
                       String deviceToken, String webSocketUrl) {
            this.ok = ok;
            this.errorCode = errorCode;
            this.message = message;
            this.deviceId = deviceId;
            this.deviceToken = deviceToken;
            this.webSocketUrl = webSocketUrl;
        }

        private static Result failure(String code, String message) {
            return new Result(false, code, message, null, null, null);
        }
    }

    private PairingClient() {
    }

    public static Result complete(String serverUrl, String code, JSONObject client) {
        if (serverUrl == null || !serverUrl.startsWith("https://")) {
            return Result.failure("INVALID_REQUEST", "The server address must start with https://");
        }
        if (code == null || code.trim().isEmpty()) {
            return Result.failure("INVALID_REQUEST", "Enter the pairing code.");
        }

        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject();
            body.put("action", "complete");
            body.put("code", code.trim().toUpperCase());
            body.put("client", client);

            URL url = new URL(serverUrl.replaceAll("/+$", "") + "/api/v1/pair");
            connection = (HttpURLConnection) url.openConnection();
            if (connection instanceof HttpsURLConnection) {
                // Certificate and hostname validation stay on: never disabled.
                ((HttpsURLConnection) connection).setSSLSocketFactory(
                        (javax.net.ssl.SSLSocketFactory) javax.net.ssl.SSLSocketFactory.getDefault());
            }
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "NexusPhoneAgent/0.1");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setInstanceFollowRedirects(false);

            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(payload);
                stream.flush();
            }

            int status = connection.getResponseCode();
            String raw = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());

            if (status != 201 && status != 200) {
                String errorCode = "PAIRING_FAILED";
                String message = "Pairing failed (HTTP " + status + ").";
                if (!raw.isEmpty()) {
                    try {
                        JSONObject error = new JSONObject(raw);
                        errorCode = error.optString("error", error.optString("code", errorCode));
                        message = error.optString("message", message);
                    } catch (org.json.JSONException ignored) {
                        // Non JSON error body: keep the HTTP status message.
                    }
                }
                return Result.failure(errorCode, message);
            }

            JSONObject response = new JSONObject(raw);
            String deviceId = response.optString("device_id", "");
            String deviceToken = response.optString("device_token", "");
            if (deviceId.isEmpty() || deviceToken.isEmpty()) {
                return Result.failure("PAIRING_FAILED", "The server did not return a device token.");
            }
            return new Result(true, null, null, deviceId, deviceToken,
                    response.optString("ws_url", ""));

        } catch (IOException e) {
            return Result.failure("SERVER_UNREACHABLE", "Could not reach the server: " + e.getMessage());
        } catch (org.json.JSONException e) {
            return Result.failure("PAIRING_FAILED", "The server sent an unreadable response.");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String read(InputStream stream) {
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        try {
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
        } catch (IOException ignored) {
            // Partial error bodies are acceptable; the caller reports the status.
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }
}

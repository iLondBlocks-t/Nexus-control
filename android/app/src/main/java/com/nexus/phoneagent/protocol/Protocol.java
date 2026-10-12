package com.nexus.phoneagent.protocol;

import com.nexus.phoneagent.util.Redactor;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

/**
 * Version 1 of the NEXUS device protocol.
 *
 * Mirrors server/src/websocket/protocol.js. Every inbound message is validated
 * here before it reaches the task executor, and every outbound message carries
 * the protocol version so an incompatible server is detected immediately.
 */
public final class Protocol {

    public static final int PROTOCOL_VERSION = 1;
    public static final String PATH = "/api/v1/device";

    // Device -> server
    public static final String TYPE_DEVICE_HELLO = "device_hello";
    public static final String TYPE_HEARTBEAT = "heartbeat";
    public static final String TYPE_DEVICE_STATUS = "device_status";
    public static final String TYPE_ACTION_RESULT = "action_result";
    public static final String TYPE_TASK_PROGRESS = "task_progress";
    public static final String TYPE_TASK_CREATE = "task_create";
    public static final String TYPE_TASK_APPROVE = "task_approve";
    public static final String TYPE_TASK_DENY = "task_deny";
    public static final String TYPE_PROTOCOL_ERROR = "protocol_error";

    // Server -> device
    public static final String TYPE_AUTH_OK = "device_auth_ok";
    public static final String TYPE_AUTH_FAILED = "device_auth_failed";
    public static final String TYPE_HEARTBEAT_ACK = "heartbeat_ack";
    public static final String TYPE_TASK_DISPATCH = "task_dispatch";
    public static final String TYPE_EXECUTE_ACTION = "execute_action";
    public static final String TYPE_CANCEL_TASK = "cancel_task";
    public static final String TYPE_APPROVAL_REQUIRED = "approval_required";
    public static final String TYPE_TASK_COMPLETED = "task_completed";
    public static final String TYPE_TASK_ACCEPTED = "task_accepted";
    public static final String TYPE_TASK_REJECTED = "task_rejected";
    public static final String TYPE_APPROVAL_RESULT = "approval_result";
    public static final String TYPE_DEVICE_REVOKED = "device_revoked";

    private Protocol() {
    }

    /* ------------------------------------------------------------------ */
    /* Outbound builders                                                    */
    /* ------------------------------------------------------------------ */

    private static JSONObject envelope(String type) throws JSONException {
        JSONObject message = new JSONObject();
        message.put("protocol_version", PROTOCOL_VERSION);
        message.put("type", type);
        message.put("message_id", newId());
        message.put("sent_at", isoNow());
        return message;
    }

    public static String newId() {
        return "msg_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }

    public static String isoNow() {
        // java.time is not available on API 23 without desugaring; use a simple
        // ISO-8601 formatter built on the platform's ISO 8601 support.
        return new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
                .format(new java.util.Date(System.currentTimeMillis()));
    }

    public static JSONObject deviceHello(String deviceId, String deviceToken, JSONObject client)
            throws JSONException {
        JSONObject message = envelope(TYPE_DEVICE_HELLO);
        message.put("device_id", deviceId);
        message.put("device_token", deviceToken);
        if (client != null) {
            message.put("client", client);
        }
        return message;
    }

    public static JSONObject heartbeat() throws JSONException {
        return envelope(TYPE_HEARTBEAT);
    }

    public static JSONObject deviceStatus(boolean accessibilityEnabled, int batteryPercent, boolean charging)
            throws JSONException {
        JSONObject message = envelope(TYPE_DEVICE_STATUS);
        message.put("accessibility_enabled", accessibilityEnabled);
        message.put("battery_percent", batteryPercent);
        message.put("charging", charging);
        return message;
    }

    public static JSONObject actionResult(String taskId, String actionId, int sequence, boolean succeeded,
                                          String errorCode, String message, long durationMs, JSONObject result)
            throws JSONException {
        JSONObject payload = envelope(TYPE_ACTION_RESULT);
        payload.put("task_id", taskId);
        payload.put("action_id", actionId);
        payload.put("sequence", sequence);
        payload.put("status", succeeded ? "succeeded" : "failed");
        if (errorCode != null) {
            payload.put("error_code", errorCode);
        }
        if (message != null) {
            payload.put("message", Redactor.truncate(message, 300));
        }
        payload.put("duration_ms", durationMs);
        if (result != null) {
            payload.put("result", result);
        }
        return payload;
    }

    public static JSONObject taskProgress(String taskId, String status, String message) throws JSONException {
        JSONObject payload = envelope(TYPE_TASK_PROGRESS);
        payload.put("task_id", taskId);
        payload.put("status", status);
        if (message != null) {
            payload.put("message", Redactor.truncate(message, 300));
        }
        return payload;
    }

    /** Approve or deny a task that is parked waiting for the owner. */
    public static JSONObject taskDecision(boolean approved, String taskId) throws JSONException {
        JSONObject payload = envelope(approved ? TYPE_TASK_APPROVE : TYPE_TASK_DENY);
        payload.put("task_id", taskId);
        return payload;
    }

    /** The owner typed an instruction on the phone; ask the server to plan it. */
    public static JSONObject taskCreate(String requestId, String instruction) throws JSONException {
        JSONObject payload = envelope(TYPE_TASK_CREATE);
        payload.put("request_id", requestId);
        payload.put("instruction", Redactor.truncate(instruction.trim(), 1000));
        return payload;
    }

    public static JSONObject protocolError(String errorCode, String message, String refMessageId)
            throws JSONException {
        JSONObject payload = envelope(TYPE_PROTOCOL_ERROR);
        payload.put("error_code", errorCode);
        payload.put("message", Redactor.truncate(message, 300));
        if (refMessageId != null) {
            payload.put("ref_message_id", refMessageId);
        }
        return payload;
    }

    /* ------------------------------------------------------------------ */
    /* Inbound parsing                                                      */
    /* ------------------------------------------------------------------ */

    /** Result of parsing an inbound frame. */
    public static final class Inbound {
        public final JSONObject json;
        public final String type;
        public final String errorCode;
        public final String errorMessage;

        private Inbound(JSONObject json, String type, String errorCode, String errorMessage) {
            this.json = json;
            this.type = type;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        public boolean isValid() {
            return json != null;
        }
    }

    public static Inbound parse(String text) {
        if (text == null || text.trim().isEmpty()) {
            return invalid("INVALID_REQUEST", "Empty message.");
        }
        JSONObject json;
        try {
            json = new JSONObject(text);
        } catch (JSONException e) {
            return invalid("INVALID_REQUEST", "Not valid JSON.");
        }

        int version = json.optInt("protocol_version", -1);
        if (version != PROTOCOL_VERSION) {
            return invalid("INVALID_PROTOCOL_VERSION", "Unsupported protocol version: " + version);
        }

        String type = json.optString("type", "");
        if (type.isEmpty()) {
            return invalid("INVALID_REQUEST", "Missing message type.");
        }

        switch (type) {
            case TYPE_AUTH_OK:
                return ok(json, type);
            case TYPE_AUTH_FAILED:
                return ok(json, type);
            case TYPE_HEARTBEAT_ACK:
                return ok(json, type);
            case TYPE_TASK_DISPATCH:
                if (!hasString(json, "task_id") || !hasString(json, "instruction")) {
                    return invalid("INVALID_REQUEST", "task_dispatch is missing required fields.");
                }
                return ok(json, type);
            case TYPE_EXECUTE_ACTION: {
                if (!hasString(json, "task_id") || !hasString(json, "action_id")) {
                    return invalid("INVALID_REQUEST", "execute_action is missing identifiers.");
                }
                int sequence = json.optInt("sequence", -1);
                if (sequence < 1) {
                    return invalid("INVALID_REQUEST", "execute_action sequence must be >= 1.");
                }
                if (!hasString(json, "expires_at")) {
                    return invalid("INVALID_REQUEST", "execute_action is missing expires_at.");
                }
                JSONObject action = json.optJSONObject("action");
                if (action == null || action.optString("type", "").isEmpty()) {
                    return invalid("INVALID_REQUEST", "execute_action is missing the action.");
                }
                return ok(json, type);
            }
            case TYPE_CANCEL_TASK:
                if (!hasString(json, "task_id")) {
                    return invalid("INVALID_REQUEST", "cancel_task is missing task_id.");
                }
                return ok(json, type);
            case TYPE_APPROVAL_REQUIRED:
                if (!hasString(json, "task_id")) {
                    return invalid("INVALID_REQUEST", "approval_required is missing task_id.");
                }
                return ok(json, type);
            case TYPE_TASK_COMPLETED:
                if (!hasString(json, "task_id")) {
                    return invalid("INVALID_REQUEST", "task_completed is missing task_id.");
                }
                return ok(json, type);
            case TYPE_DEVICE_REVOKED:
                return ok(json, type);
            case TYPE_TASK_CREATE:
                if (!hasString(json, "request_id") || !hasString(json, "instruction")) {
                    return invalid("INVALID_REQUEST", "task_create is missing fields.");
                }
                return ok(json, type);
            case TYPE_TASK_APPROVE:
            case TYPE_TASK_DENY:
                if (!hasString(json, "task_id")) {
                    return invalid("INVALID_REQUEST", "The decision is missing task_id.");
                }
                return ok(json, type);
            case TYPE_TASK_ACCEPTED:
                if (!hasString(json, "request_id") || !hasString(json, "task_id")) {
                    return invalid("INVALID_REQUEST", "task_accepted is missing fields.");
                }
                return ok(json, type);
            case TYPE_TASK_REJECTED:
                if (!hasString(json, "request_id")) {
                    return invalid("INVALID_REQUEST", "task_rejected is missing its request id.");
                }
                return ok(json, type);
            case TYPE_APPROVAL_RESULT:
                if (!hasString(json, "task_id")) {
                    return invalid("INVALID_REQUEST", "approval_result is missing task_id.");
                }
                return ok(json, type);
            case TYPE_PROTOCOL_ERROR:
                return ok(json, type);
            default:
                return invalid("INVALID_REQUEST", "Unknown message type: " + type);
        }
    }

    private static boolean hasString(JSONObject json, String key) {
        String value = json.optString(key, "");
        return !value.isEmpty();
    }

    private static Inbound ok(JSONObject json, String type) {
        return new Inbound(json, type, null, null);
    }

    private static Inbound invalid(String code, String message) {
        return new Inbound(null, null, code, message);
    }

    /** Reads the human readable reasons of an approval_required message. */
    public static String approvalReasons(JSONObject json) {
        JSONArray reasons = json.optJSONArray("reasons");
        if (reasons == null || reasons.length() == 0) {
            return "This task touches a sensitive action.";
        }
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < reasons.length(); i += 1) {
            String reason = reasons.optString(i, "");
            if (reason.isEmpty()) {
                continue;
            }
            if (builder.length() > 0) {
                builder.append('\n');
            }
            builder.append("• ").append(reason);
        }
        return builder.length() == 0 ? "This task touches a sensitive action." : builder.toString();
    }
}

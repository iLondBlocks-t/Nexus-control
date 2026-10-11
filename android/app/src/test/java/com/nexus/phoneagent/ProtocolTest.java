package com.nexus.phoneagent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.nexus.phoneagent.protocol.Protocol;

import org.json.JSONObject;
import org.junit.Test;

/** The phone's half of protocol v1: builders and inbound validation. */
public class ProtocolTest {

    @Test
    public void theVersionMatchesTheServer() {
        assertEquals(1, Protocol.PROTOCOL_VERSION);
    }

    @Test
    public void gibberishIsRejected() {
        assertFalse(Protocol.parse(null).isValid());
        assertFalse(Protocol.parse("   ").isValid());
        assertFalse(Protocol.parse("not json at all").isValid());
        assertEquals("INVALID_REQUEST", Protocol.parse("nope").errorCode);
    }

    @Test
    public void anotherProtocolVersionIsRejected() {
        JSONObject message = new JSONObject();
        message.put("protocol_version", 2).put("type", "heartbeat");
        Protocol.Inbound inbound = Protocol.parse(message.toString());
        assertFalse(inbound.isValid());
        assertEquals("INVALID_PROTOCOL_VERSION", inbound.errorCode);
    }

    @Test
    public void unknownMessageTypesAreRejected() {
        JSONObject message = new JSONObject();
        message.put("protocol_version", 1).put("type", "delete_everything");
        Protocol.Inbound inbound = Protocol.parse(message.toString());
        assertFalse(inbound.isValid());
        assertEquals("INVALID_REQUEST", inbound.errorCode);
    }

    @Test
    public void heartbeatAndStatusAreAccepted() {
        assertTrue(Protocol.parse(new JSONObject()
                .put("protocol_version", 1).put("type", "heartbeat").toString()).isValid());
        assertTrue(Protocol.parse(new JSONObject()
                .put("protocol_version", 1).put("type", "heartbeat_ack").toString()).isValid());
    }

    @Test
    public void anExecuteActionNeedsIdentifiersAnActionAndAnExpiry() {
        JSONObject complete = new JSONObject()
                .put("protocol_version", 1)
                .put("type", "execute_action")
                .put("task_id", "task_1")
                .put("action_id", "action_1")
                .put("sequence", 1)
                .put("expires_at", "2030-01-01T00:00:00.000Z")
                .put("action", new JSONObject().put("type", "back"));
        assertTrue(Protocol.parse(complete.toString()).isValid());

        JSONObject noAction = new JSONObject()
                .put("protocol_version", 1)
                .put("type", "execute_action")
                .put("task_id", "task_1")
                .put("action_id", "action_1")
                .put("sequence", 1)
                .put("expires_at", "2030-01-01T00:00:00.000Z");
        assertFalse(Protocol.parse(noAction.toString()).isValid());

        JSONObject badSequence = new JSONObject()
                .put("protocol_version", 1)
                .put("type", "execute_action")
                .put("task_id", "task_1")
                .put("action_id", "action_1")
                .put("sequence", 0)
                .put("expires_at", "2030-01-01T00:00:00.000Z")
                .put("action", new JSONObject().put("type", "back"));
        assertFalse(Protocol.parse(badSequence.toString()).isValid());
    }

    @Test
    public void theHelloCarriesTheCredentialOnce() {
        JSONObject hello = Protocol.deviceHello("dev_1", "token-value", null);
        assertEquals(1, hello.optInt("protocol_version", -1));
        assertEquals("device_hello", hello.optString("type"));
        assertEquals("dev_1", hello.optString("device_id"));
        assertEquals("token-value", hello.optString("device_token"));
        assertNotNull(hello.optString("message_id"));
    }

    @Test
    public void taskCreationRequestsAreWellFormed() throws Exception {
        JSONObject request = Protocol.taskCreate("req_1", "Open YouTube");
        assertEquals("task_create", request.optString("type"));
        assertEquals("req_1", request.optString("request_id"));
        assertEquals("Open YouTube", request.optString("instruction"));
        assertEquals(1, request.optInt("protocol_version", -1));
    }

    @Test
    public void approvalDecisionsAreWellFormed() throws Exception {
        assertEquals("task_approve", Protocol.taskDecision(true, "task_1").optString("type"));
        assertEquals("task_deny", Protocol.taskDecision(false, "task_1").optString("type"));
        assertEquals("task_1", Protocol.taskDecision(true, "task_1").optString("task_id"));
    }

    @Test
    public void actionResultsUseTheProtocolVocabulary() throws Exception {
        JSONObject ok = Protocol.actionResult("task_1", "action_1", 2, true, null,
                "Opened YouTube", 120L, null);
        assertEquals("action_result", ok.optString("type"));
        assertEquals("succeeded", ok.optString("status"));
        assertEquals(2, ok.optInt("sequence", -1));
        assertEquals(120L, ok.optLong("duration_ms", -1L));
        assertFalse(ok.has("error_code"));

        JSONObject failed = Protocol.actionResult("task_1", "action_1", 2, false,
                "TARGET_NOT_FOUND", "nothing matched", 30L, null);
        assertEquals("failed", failed.optString("status"));
        assertEquals("TARGET_NOT_FOUND", failed.optString("error_code"));
    }

    @Test
    public void approvalReasonsFallBackToASafeMessage() {
        JSONObject empty = new JSONObject();
        empty.put("reasons", new org.json.JSONArray());
        assertFalse(Protocol.approvalReasons(empty).isEmpty());

        JSONObject withReasons = new JSONObject();
        withReasons.put("reasons", new org.json.JSONArray().put("taps Send"));
        assertEquals("• taps Send", Protocol.approvalReasons(withReasons));
    }
}

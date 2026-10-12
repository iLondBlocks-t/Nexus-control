package com.nexus.phoneagent.model;

import org.json.JSONException;
import org.json.JSONObject;

/** One action of a task, as recorded locally for the history screen. */
public final class ActionRecord {

    public final String actionId;
    public final int index;
    public final String type;
    public final String summary;
    public String status;
    public String errorCode;
    public String message;
    public long durationMs;

    public ActionRecord(String actionId, int index, String type, String summary) {
        this.actionId = actionId;
        this.index = index;
        this.type = type;
        this.summary = summary;
        this.status = "pending";
    }

    public JSONObject toJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("action_id", actionId);
            json.put("id", actionId);
            json.put("index", index);
            json.put("type", type);
            json.put("summary", summary);
            json.put("status", status);
            json.put("error_code", errorCode);
            json.put("message", message);
            json.put("duration_ms", durationMs);
        } catch (JSONException ignored) {
            // Keys are constant literals; this cannot fail.
        }
        return json;
    }

    public static ActionRecord fromJson(JSONObject json) {
        ActionRecord record = new ActionRecord(
                json.optString("action_id", json.optString("id", "")),
                json.optInt("index", 0),
                json.optString("type", ""),
                json.optString("summary", ""));
        record.status = json.optString("status", "pending");
        record.errorCode = json.optString("error_code", null);
        record.message = json.optString("message", null);
        record.durationMs = json.optLong("duration_ms", 0L);
        return record;
    }
}

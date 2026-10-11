package com.nexus.phoneagent.model;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** A task as the phone sees it: instruction, planned actions, outcome. */
public final class TaskRecord {

    public final String taskId;
    public final String instruction;
    public final long startedAt;
    public final int totalActions;
    public final List<ActionRecord> actions = new ArrayList<>();
    public String status = "running";
    public long endedAt;
    public String errorCode;
    public String errorMessage;
    public String resultSummary;
    public String approvalState;

    public TaskRecord(String taskId, String instruction, long startedAt, int totalActions) {
        this.taskId = taskId;
        this.instruction = instruction;
        this.startedAt = startedAt;
        this.totalActions = totalActions;
    }

    public JSONObject toJson() {
        JSONObject json = new JSONObject();
        JSONArray array = new JSONArray();
        for (ActionRecord action : actions) {
            array.put(action.toJson());
        }
        try {
            json.put("task_id", taskId);
            json.put("id", taskId);
            json.put("instruction", instruction);
            json.put("status", status);
            json.put("started_at", startedAt);
            json.put("ended_at", endedAt);
            json.put("total_actions", totalActions);
            json.put("error_code", errorCode);
            json.put("error_message", errorMessage);
            json.put("result_summary", resultSummary);
            json.put("approval_state", approvalState);
            json.put("actions", array);
        } catch (JSONException ignored) {
            // Keys are constant literals; this cannot fail.
        }
        return json;
    }

    public static TaskRecord fromJson(JSONObject json) {
        TaskRecord record = new TaskRecord(
                json.optString("task_id", json.optString("id", "")),
                json.optString("instruction", ""),
                json.optLong("started_at", System.currentTimeMillis()),
                json.optInt("total_actions", 0));
        record.status = json.optString("status", "running");
        record.endedAt = json.optLong("ended_at", 0L);
        record.errorCode = json.optString("error_code", null);
        record.errorMessage = json.optString("error_message", null);
        record.resultSummary = json.optString("result_summary", null);
        record.approvalState = json.optString("approval_state", null);
        JSONArray array = json.optJSONArray("actions");
        if (array != null) {
            for (int i = 0; i < array.length(); i += 1) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) {
                    record.actions.add(ActionRecord.fromJson(item));
                }
            }
        }
        return record;
    }
}

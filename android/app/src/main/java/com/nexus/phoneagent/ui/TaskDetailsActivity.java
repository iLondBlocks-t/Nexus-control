package com.nexus.phoneagent.ui;

import android.os.Bundle;
import android.widget.TextView;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.data.TaskStore;
import com.nexus.phoneagent.model.ActionRecord;
import com.nexus.phoneagent.model.TaskRecord;
import com.nexus.phoneagent.service.NexusConnectionService;

/** Full record of one task, read back from local storage. */
public class TaskDetailsActivity extends android.app.Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_task_details);

        String taskId = getIntent().getStringExtra(NexusConnectionService.EXTRA_TASK_ID);
        TaskStore store = TaskStore.get(this);
        TaskRecord record = taskId == null ? null : store.get(taskId);

        TextView idView = findViewById(R.id.details_id);
        TextView instructionView = findViewById(R.id.details_instruction);
        TextView statusView = findViewById(R.id.details_status);
        TextView actionsView = findViewById(R.id.details_actions);
        TextView startedView = findViewById(R.id.details_started);
        TextView durationView = findViewById(R.id.details_duration);
        TextView resultView = findViewById(R.id.details_result);
        TextView errorView = findViewById(R.id.details_error);

        if (record == null) {
            idView.setText(taskId == null ? getString(R.string.value_none) : taskId);
            instructionView.setText(getString(R.string.value_none));
            statusView.setText(getString(R.string.value_none));
            actionsView.setText(getString(R.string.value_none));
            startedView.setText(getString(R.string.value_none));
            durationView.setText(getString(R.string.value_none));
            resultView.setText(getString(R.string.value_none));
            errorView.setText(getString(R.string.value_none));
            return;
        }

        idView.setText(record.taskId);
        instructionView.setText(record.instruction.isEmpty()
                ? getString(R.string.value_none) : record.instruction);
        statusView.setText(Format.status(record.status)
                + (record.approvalState == null ? "" : " · " + Format.status(record.approvalState)));

        StringBuilder actions = new StringBuilder();
        actions.append(record.actions.size()).append(" of ")
                .append(Math.max(record.totalActions, record.actions.size()))
                .append(" recorded\n");
        for (ActionRecord action : record.actions) {
            actions.append(action.index).append(". ").append(action.summary)
                    .append(" — ").append(Format.status(action.status));
            if (action.errorCode != null && !action.errorCode.isEmpty()) {
                actions.append(" (").append(action.errorCode).append(')');
            }
            actions.append('\n');
        }
        actionsView.setText(actions.toString().trim());

        startedView.setText(Format.time(record.startedAt));
        long endedAt = record.endedAt > 0L ? record.endedAt : System.currentTimeMillis();
        durationView.setText(Format.duration(endedAt - record.startedAt));

        resultView.setText(record.resultSummary == null
                ? getString(R.string.value_none) : record.resultSummary);

        if (record.errorCode != null && !record.errorCode.isEmpty()) {
            errorView.setText(record.errorCode
                    + (record.errorMessage == null ? "" : ": " + record.errorMessage));
        } else if ("cancelled".equals(record.status)) {
            errorView.setText(R.string.detail_cancelled);
        } else {
            errorView.setText(getString(R.string.value_none));
        }
    }
}

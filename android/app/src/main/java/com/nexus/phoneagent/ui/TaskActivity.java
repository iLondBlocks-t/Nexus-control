package com.nexus.phoneagent.ui;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.data.TaskStore;
import com.nexus.phoneagent.model.ActionRecord;
import com.nexus.phoneagent.model.TaskRecord;
import com.nexus.phoneagent.service.NexusAccessibilityService;
import com.nexus.phoneagent.service.NexusConnectionService;

/**
 * Task input and live progress.
 *
 * The instruction is sent to the server, which plans it, screens it against the
 * policy engine and dispatches actions back to this phone. Everything shown here
 * comes from the real task record: nothing is simulated.
 */
public class TaskActivity extends android.app.Activity {

    private TaskStore taskStore;
    private EditText instructionField;
    private Button submitButton;
    private Button cancelButton;
    private TextView progressView;
    private TextView planView;
    private TextView resultView;
    private TextView errorView;
    private ProgressBar spinner;
    private LinearLayout approvalCard;
    private TextView approvalReasons;

    private String currentTaskId = "";

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) {
                return;
            }
            String action = intent.getAction();
            if (NexusConnectionService.ACTION_SUBMIT_RESULT.equals(action)) {
                String taskId = intent.getStringExtra(NexusConnectionService.EXTRA_TASK_ID);
                String errorCode = intent.getStringExtra(NexusConnectionService.EXTRA_ERROR_CODE);
                String message = intent.getStringExtra(NexusConnectionService.EXTRA_MESSAGE);
                if (taskId != null && !taskId.isEmpty()) {
                    currentTaskId = taskId;
                }
                if (errorCode != null && !errorCode.isEmpty()) {
                    showError(errorCode + ": " + message);
                }
            } else if (NexusConnectionService.ACTION_TASK_UPDATE.equals(action)) {
                String taskId = intent.getStringExtra(NexusConnectionService.EXTRA_TASK_ID);
                if (taskId != null && !taskId.isEmpty()) {
                    currentTaskId = taskId;
                }
            } else if (NexusConnectionService.ACTION_APPROVAL_REQUIRED.equals(action)) {
                String taskId = intent.getStringExtra(NexusConnectionService.EXTRA_TASK_ID);
                String reasons = intent.getStringExtra(NexusConnectionService.EXTRA_MESSAGE);
                if (taskId != null && !taskId.isEmpty()) {
                    currentTaskId = taskId;
                }
                if (reasons != null && !reasons.isEmpty()) {
                    approvalReasons.setText(reasons);
                }
                approvalCard.setVisibility(View.VISIBLE);
            }
            refresh();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_task);

        taskStore = TaskStore.get(this);

        instructionField = findViewById(R.id.task_instruction);
        submitButton = findViewById(R.id.task_submit);
        cancelButton = findViewById(R.id.task_cancel);
        progressView = findViewById(R.id.task_progress);
        planView = findViewById(R.id.task_plan);
        resultView = findViewById(R.id.task_result);
        errorView = findViewById(R.id.task_error);
        spinner = findViewById(R.id.task_spinner);
        approvalCard = findViewById(R.id.task_approval);
        approvalReasons = findViewById(R.id.task_approval_reasons);

        String passedTaskId = getIntent().getStringExtra(NexusConnectionService.EXTRA_TASK_ID);
        if (passedTaskId != null && !passedTaskId.isEmpty()) {
            currentTaskId = passedTaskId;
        }
        String passedReasons = getIntent().getStringExtra(NexusConnectionService.EXTRA_MESSAGE);
        if (passedReasons != null && !passedReasons.isEmpty()) {
            approvalReasons.setText(passedReasons);
        }

        submitButton.setOnClickListener(view -> submit());
        cancelButton.setOnClickListener(view -> cancel());
        findViewById(R.id.task_approve).setOnClickListener(view -> decide(true));
        findViewById(R.id.task_deny).setOnClickListener(view -> decide(false));
    }

    @Override
    protected void onResume() {
        super.onResume();
        IntentFilter filter = new IntentFilter(NexusConnectionService.ACTION_TASK_UPDATE);
        filter.addAction(NexusConnectionService.ACTION_SUBMIT_RESULT);
        filter.addAction(NexusConnectionService.ACTION_APPROVAL_REQUIRED);
        filter.addAction(NexusConnectionService.ACTION_STATE_CHANGED);
        registerReceiver(receiver, filter);
        refresh();
    }

    @Override
    protected void onPause() {
        try {
            unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // Not registered in this lifecycle pass.
        }
        super.onPause();
    }

    private void submit() {
        String instruction = instructionField.getText().toString().trim();
        if (instruction.isEmpty()) {
            Toast.makeText(this, R.string.task_instruction_hint, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!NexusConnectionService.isConnected()) {
            Toast.makeText(this, R.string.task_needs_connection, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!NexusAccessibilityService.isEnabled()) {
            Toast.makeText(this, R.string.task_needs_accessibility, Toast.LENGTH_SHORT).show();
            return;
        }

        errorView.setText("");
        resultView.setText("");
        planView.setText(getString(R.string.value_none));
        approvalCard.setVisibility(View.GONE);

        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_SUBMIT_TASK);
        intent.putExtra(NexusConnectionService.EXTRA_INSTRUCTION, instruction);
        startService(intent);
        Toast.makeText(this, R.string.task_sent, Toast.LENGTH_SHORT).show();
    }

    private void cancel() {
        if (currentTaskId.isEmpty()) {
            return;
        }
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_STOP_TASK);
        intent.putExtra(NexusConnectionService.EXTRA_TASK_ID, currentTaskId);
        startService(intent);
        Toast.makeText(this, R.string.task_cancelled, Toast.LENGTH_SHORT).show();
    }

    private void decide(boolean approved) {
        if (currentTaskId.isEmpty()) {
            return;
        }
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_DECIDE_TASK);
        intent.putExtra(NexusConnectionService.EXTRA_TASK_ID, currentTaskId);
        intent.putExtra(NexusConnectionService.EXTRA_APPROVED, approved);
        startService(intent);
        approvalCard.setVisibility(View.GONE);
    }

    private void refresh() {
        if (currentTaskId.isEmpty()) {
            String active = NexusConnectionService.getActiveTaskId();
            if (!active.isEmpty()) {
                currentTaskId = active;
            }
        }
        TaskRecord record = currentTaskId.isEmpty() ? null : taskStore.get(currentTaskId);
        if (record == null) {
            progressView.setText(getString(R.string.value_none));
            planView.setText(getString(R.string.value_none));
            spinner.setVisibility(View.GONE);
            cancelButton.setEnabled(false);
            return;
        }

        boolean running = "running".equals(record.status) || "queued".equals(record.status)
                || "planning".equals(record.status) || "awaiting_approval".equals(record.status);
        spinner.setVisibility(running ? View.VISIBLE : View.GONE);
        cancelButton.setEnabled(running);

        int total = Math.max(record.totalActions, record.actions.size());
        int done = 0;
        for (ActionRecord action : record.actions) {
            if ("succeeded".equals(action.status) || "failed".equals(action.status)) {
                done += 1;
            }
        }
        progressView.setText(getString(R.string.task_progress, done, total)
                + " — " + Format.status(record.status));

        StringBuilder plan = new StringBuilder();
        for (ActionRecord action : record.actions) {
            plan.append(action.index).append(". ").append(action.summary)
                    .append(" — ").append(Format.status(action.status));
            if (action.message != null && !action.message.isEmpty()) {
                plan.append(" (").append(action.message).append(')');
            }
            plan.append('\n');
        }
        planView.setText(plan.length() == 0 ? getString(R.string.value_none) : plan.toString().trim());

        resultView.setText(record.resultSummary == null ? getString(R.string.value_none)
                : record.resultSummary);

        approvalCard.setVisibility("awaiting_approval".equals(record.status)
                ? View.VISIBLE : View.GONE);

        if (record.errorCode != null && !record.errorCode.isEmpty()) {
            showError(record.errorCode
                    + (record.errorMessage == null ? "" : ": " + record.errorMessage));
        } else {
            errorView.setText("");
        }
    }

    private void showError(String text) {
        errorView.setText(getString(R.string.task_error_label) + ": " + text);
    }
}

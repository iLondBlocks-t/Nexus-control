package com.nexus.phoneagent.ui;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.core.Config;
import com.nexus.phoneagent.core.SecureStore;
import com.nexus.phoneagent.data.TaskStore;
import com.nexus.phoneagent.model.ConnectionState;
import com.nexus.phoneagent.model.TaskRecord;
import com.nexus.phoneagent.service.NexusAccessibilityService;
import com.nexus.phoneagent.service.NexusConnectionService;

import java.util.List;

/**
 * Dashboard: the real connection state, the active task, the emergency stop and
 * the recent task history.
 *
 * It never shows "Connected" unless the service has actually completed an
 * authenticated WebSocket session.
 */
public class MainActivity extends android.app.Activity {

    private Config config;
    private SecureStore store;
    private TaskStore taskStore;

    private TextView stateView;
    private TextView serverView;
    private TextView deviceView;
    private TextView accessibilityView;
    private TextView heartbeatView;
    private TextView activeTaskView;
    private TextView historyEmptyView;
    private View statusDot;
    private Button stopButton;
    private ListView historyList;
    private TaskAdapter adapter;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent == null ? null : intent.getAction();
            if (action == null) {
                return;
            }
            if (NexusConnectionService.ACTION_APPROVAL_REQUIRED.equals(action)) {
                String taskId = intent.getStringExtra(NexusConnectionService.EXTRA_TASK_ID);
                Intent details = new Intent(MainActivity.this, TaskActivity.class);
                details.putExtra(NexusConnectionService.EXTRA_TASK_ID, taskId);
                details.putExtra(NexusConnectionService.EXTRA_MESSAGE,
                        intent.getStringExtra(NexusConnectionService.EXTRA_MESSAGE));
                startActivity(details);
            }
            refresh();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        config = new Config(this);
        store = new SecureStore(this);
        taskStore = TaskStore.get(this);

        stateView = findViewById(R.id.main_state);
        serverView = findViewById(R.id.main_server);
        deviceView = findViewById(R.id.main_device);
        accessibilityView = findViewById(R.id.main_accessibility);
        heartbeatView = findViewById(R.id.main_heartbeat);
        activeTaskView = findViewById(R.id.main_active_task);
        historyEmptyView = findViewById(R.id.main_history_empty);
        statusDot = findViewById(R.id.main_status_dot);
        stopButton = findViewById(R.id.main_stop);
        historyList = findViewById(R.id.main_history);

        adapter = new TaskAdapter(this);
        historyList.setAdapter(adapter);
        historyList.setOnItemClickListener(this::onHistoryClick);

        findViewById(R.id.main_send).setOnClickListener(view -> submitTask());
        findViewById(R.id.main_new_task).setOnClickListener(
                view -> startActivity(new Intent(this, TaskActivity.class)));
        findViewById(R.id.main_settings).setOnClickListener(
                view -> startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.main_accessibility_action).setOnClickListener(
                view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        stopButton.setOnClickListener(view -> stopTask());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!config.isConfigured() || !store.hasCredentials()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }
        IntentFilter filter = new IntentFilter(NexusConnectionService.ACTION_STATE_CHANGED);
        filter.addAction(NexusConnectionService.ACTION_TASK_UPDATE);
        filter.addAction(NexusConnectionService.ACTION_APPROVAL_REQUIRED);
        filter.addAction(NexusConnectionService.ACTION_SUBMIT_RESULT);
        registerReceiver(receiver, filter);

        requestNotificationPermissionIfNeeded();
        startConnection();
        taskStore.prune(config.getRetentionDays());
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

    /** The notification is only optional from the user's point of view on API 33+. */
    private void requestNotificationPermissionIfNeeded() {
        if (android.os.Build.VERSION.SDK_INT < 33) {
            return;
        }
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 1001);
    }

    private void startConnection() {
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_START);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void submitTask() {
        EditText field = findViewById(R.id.main_instruction);
        String instruction = field.getText().toString().trim();
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
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_SUBMIT_TASK);
        intent.putExtra(NexusConnectionService.EXTRA_INSTRUCTION, instruction);
        startService(intent);
        field.setText("");
        Toast.makeText(this, R.string.task_sent, Toast.LENGTH_SHORT).show();
    }

    private void stopTask() {
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_STOP_TASK);
        startService(intent);
        Toast.makeText(this, R.string.task_stopped, Toast.LENGTH_SHORT).show();
    }

    private void onHistoryClick(AdapterView<?> parent, View view, int position, long id) {
        TaskRecord record = adapter.getItem(position);
        Intent intent = new Intent(this, TaskDetailsActivity.class);
        intent.putExtra(NexusConnectionService.EXTRA_TASK_ID, record.taskId);
        startActivity(intent);
    }

    private void refresh() {
        ConnectionState state = NexusConnectionService.getState();
        stateView.setText(Format.stateLabel(this, state));

        String error = NexusConnectionService.getLastError();
        if (!error.isEmpty() && state != ConnectionState.CONNECTED) {
            stateView.setText(Format.stateLabel(this, state) + " — " + error);
        }

        android.graphics.drawable.Drawable background = statusDot.getBackground();
        if (background instanceof GradientDrawable) {
            ((GradientDrawable) background.mutate()).setColor(Format.stateColor(this, state));
        }

        String server = config.getServerUrl();
        serverView.setText(server.isEmpty() ? getString(R.string.value_not_set) : server);

        String deviceId = config.getDeviceId();
        deviceView.setText(deviceId.isEmpty() ? getString(R.string.value_not_set) : deviceId);

        boolean accessibility = NexusAccessibilityService.isEnabled();
        accessibilityView.setText(accessibility
                ? getString(R.string.value_enabled) : getString(R.string.value_disabled));

        long heartbeat = NexusConnectionService.getLastHeartbeatAt();
        heartbeatView.setText(heartbeat <= 0L
                ? getString(R.string.value_never) : Format.time(heartbeat));

        String activeTaskId = NexusConnectionService.getActiveTaskId();
        TaskRecord active = activeTaskId.isEmpty() ? null : taskStore.get(activeTaskId);
        activeTaskView.setText(active == null
                ? getString(R.string.value_none)
                : (active.instruction.isEmpty() ? active.taskId : active.instruction)
                + " — " + Format.status(active.status));
        stopButton.setEnabled(active != null);

        List<TaskRecord> records = taskStore.all();
        adapter.replace(records);
        boolean empty = records.isEmpty();
        historyEmptyView.setVisibility(empty ? View.VISIBLE : View.GONE);
        historyList.setVisibility(empty ? View.GONE : View.VISIBLE);
    }
}

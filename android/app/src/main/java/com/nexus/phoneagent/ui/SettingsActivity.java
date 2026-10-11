package com.nexus.phoneagent.ui;

import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.EditText;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.core.Config;
import com.nexus.phoneagent.core.SecureStore;
import com.nexus.phoneagent.data.TaskStore;
import com.nexus.phoneagent.model.ConnectionState;
import com.nexus.phoneagent.service.NexusConnectionService;

/**
 * Owner settings.
 *
 * Every switch here narrows what the phone is willing to do, independently of
 * the server: turning "Type text" off makes the device refuse type_text even if
 * a plan asks for it.
 */
public class SettingsActivity extends android.app.Activity {

    private Config config;
    private SecureStore store;

    private EditText serverField;
    private EditText webSocketField;
    private EditText maxActionsField;
    private EditText maxDurationField;
    private EditText retentionField;
    private Switch allowTap;
    private Switch allowScroll;
    private Switch allowType;
    private Switch allowRead;
    private Switch sharePackages;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        config = new Config(this);
        store = new SecureStore(this);

        serverField = findViewById(R.id.settings_server);
        webSocketField = findViewById(R.id.settings_ws);
        maxActionsField = findViewById(R.id.settings_max_actions);
        maxDurationField = findViewById(R.id.settings_max_duration);
        retentionField = findViewById(R.id.settings_retention);
        allowTap = findViewById(R.id.settings_allow_tap);
        allowScroll = findViewById(R.id.settings_allow_scroll);
        allowType = findViewById(R.id.settings_allow_type);
        allowRead = findViewById(R.id.settings_allow_read);
        sharePackages = findViewById(R.id.settings_share_packages);

        load();

        findViewById(R.id.settings_save).setOnClickListener(view -> save());
        findViewById(R.id.settings_disconnect).setOnClickListener(view -> disconnect());
        findViewById(R.id.settings_revoke).setOnClickListener(view -> revoke());
        findViewById(R.id.settings_accessibility).setOnClickListener(
                view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));

        ((TextView) findViewById(R.id.settings_version)).setText(
                getString(R.string.settings_version, versionName()));
    }

    private void load() {
        serverField.setText(config.getServerUrl());
        webSocketField.setText(config.getWebSocketOverride());
        maxActionsField.setText(String.valueOf(config.getMaxActions()));
        maxDurationField.setText(String.valueOf(config.getMaxDurationSeconds()));
        retentionField.setText(String.valueOf(config.getRetentionDays()));
        allowTap.setChecked(config.isActionAllowed("tap_element"));
        allowScroll.setChecked(config.isActionAllowed("scroll"));
        allowType.setChecked(config.isActionAllowed("type_text"));
        allowRead.setChecked(config.isActionAllowed("read_visible_ui"));
        sharePackages.setChecked(config.isSharePackagesEnabled());
        refreshPairingStatus();
    }

    private void refreshPairingStatus() {
        TextView status = findViewById(R.id.settings_pairing_status);
        String deviceId = config.getDeviceId();
        boolean paired = store.hasCredentials() && !deviceId.isEmpty();
        StringBuilder text = new StringBuilder();
        text.append(paired ? "paired" : "not paired");
        if (!deviceId.isEmpty()) {
            text.append('\n').append(deviceId);
        }
        text.append('\n').append(Format.stateLabel(this, NexusConnectionService.getState()));
        String error = NexusConnectionService.getLastError();
        if (!error.isEmpty() && NexusConnectionService.getState() != ConnectionState.CONNECTED) {
            text.append(" — ").append(error);
        }
        status.setText(text.toString());
    }

    private void save() {
        String server = serverField.getText().toString().trim();
        if (!server.isEmpty() && !Config.isHttpUrl(server)) {
            Toast.makeText(this, R.string.setup_server_invalid, Toast.LENGTH_LONG).show();
            return;
        }
        String override = webSocketField.getText().toString().trim();
        if (!override.isEmpty() && !Config.isWebSocketUrl(override)) {
            Toast.makeText(this, R.string.setup_server_invalid, Toast.LENGTH_LONG).show();
            return;
        }

        config.setServerUrl(server);
        config.setWebSocketOverride(override);
        config.setMaxActions(parseInt(maxActionsField, config.getMaxActions()));
        config.setMaxDurationSeconds(parseInt(maxDurationField, config.getMaxDurationSeconds()));
        config.setRetentionDays(parseInt(retentionField, config.getRetentionDays()));
        config.setActionAllowed("tap_element", allowTap.isChecked());
        config.setActionAllowed("scroll", allowScroll.isChecked());
        config.setActionAllowed("type_text", allowType.isChecked());
        config.setActionAllowed("read_visible_ui", allowRead.isChecked());
        config.setSharePackagesEnabled(sharePackages.isChecked());

        TaskStore.get(this).prune(config.getRetentionDays());
        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show();

        if (config.isConfigured() && store.hasCredentials()) {
            Intent intent = new Intent(this, NexusConnectionService.class);
            intent.setAction(NexusConnectionService.ACTION_STOP);
            startService(intent);
            Intent start = new Intent(this, NexusConnectionService.class);
            start.setAction(NexusConnectionService.ACTION_START);
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                startForegroundService(start);
            } else {
                startService(start);
            }
        }
        refreshPairingStatus();
    }

    private void disconnect() {
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_STOP);
        startService(intent);
        refreshPairingStatus();
    }

    /** Forget the device credential locally. The server still has to revoke it. */
    private void revoke() {
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_STOP);
        startService(intent);

        store.clear();
        config.setPaired(false);
        config.setDeviceId("");
        TaskStore.get(this).clear();
        Toast.makeText(this, R.string.state_revoked, Toast.LENGTH_LONG).show();

        startActivity(new Intent(this, SetupActivity.class));
        finish();
    }

    private static int parseInt(EditText field, int fallback) {
        try {
            return Integer.parseInt(field.getText().toString().trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.1.0";
        }
    }
}

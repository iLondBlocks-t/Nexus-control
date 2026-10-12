package com.nexus.phoneagent.ui;

import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.core.Config;
import com.nexus.phoneagent.core.SecureStore;
import com.nexus.phoneagent.net.PairingClient;
import com.nexus.phoneagent.service.NexusConnectionService;

import org.json.JSONObject;

/**
 * First run: pair the phone with the owner's own server.
 *
 * The pairing code is created by the owner (CLI or bot) and typed in here. The
 * server answers once with a device token, which is stored immediately and
 * never displayed again.
 */
public class SetupActivity extends android.app.Activity {

    private Config config;
    private SecureStore store;
    private EditText serverField;
    private EditText codeField;
    private Button connectButton;
    private TextView statusView;
    private volatile boolean pairingInFlight;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_setup);

        config = new Config(this);
        store = new SecureStore(this);

        serverField = findViewById(R.id.setup_server);
        codeField = findViewById(R.id.setup_code);
        connectButton = findViewById(R.id.setup_connect);
        statusView = findViewById(R.id.setup_status);

        String saved = config.getServerUrl();
        if (!saved.isEmpty()) {
            serverField.setText(saved);
        }

        connectButton.setOnClickListener(this::onConnect);
        findViewById(R.id.setup_skip).setOnClickListener(view -> {
            if (config.isConfigured() && store.hasCredentials()) {
                openMain();
            } else {
                show(getString(R.string.setup_code_invalid));
            }
        });
        findViewById(R.id.setup_accessibility).setOnClickListener(
                view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
    }

    private void onConnect(View view) {
        final String server = serverField.getText().toString().trim();
        final String code = codeField.getText().toString().trim();

        if (!Config.isHttpUrl(server)) {
            show(getString(R.string.setup_server_invalid));
            return;
        }
        if (code.length() < 4) {
            show(getString(R.string.setup_code_invalid));
            return;
        }
        if (pairingInFlight) {
            return;
        }

        pairingInFlight = true;
        connectButton.setEnabled(false);
        statusView.setVisibility(View.VISIBLE);
        statusView.setText(R.string.setup_pairing_started);

        final JSONObject client = new JSONObject();
        try {
            client.put("app_version", versionName());
            client.put("android_version", android.os.Build.VERSION.RELEASE);
            client.put("device_model", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
            client.put("accessibility_enabled",
                    com.nexus.phoneagent.service.NexusAccessibilityService.isEnabled());
            if (config.isSharePackagesEnabled()) {
                client.put("launcher_packages", new org.json.JSONArray(
                        new java.util.ArrayList<>(launcherPackages())));
            }
        } catch (org.json.JSONException ignored) {
            // Constant keys; cannot fail.
        }

        new Thread(() -> {
            PairingClient.Result result = PairingClient.complete(server, code, client);
            runOnUiThread(() -> finishPairing(server, result));
        }, "nexus-pairing").start();
    }

    private void finishPairing(String server, PairingClient.Result result) {
        pairingInFlight = false;
        connectButton.setEnabled(true);

        if (!result.ok) {
            statusView.setText(getString(R.string.setup_pairing_failed,
                    result.message == null ? result.errorCode : result.message));
            return;
        }

        config.setServerUrl(server);
        config.setDeviceId(result.deviceId);
        config.setDeviceLabel(android.os.Build.MODEL);
        config.setPaired(true);
        store.storeDeviceToken(result.deviceToken);

        Toast.makeText(this, R.string.setup_pairing_done, Toast.LENGTH_SHORT).show();
        startConnection();
        openMain();
    }

    private void openMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private void startConnection() {
        Intent intent = new Intent(this, NexusConnectionService.class);
        intent.setAction(NexusConnectionService.ACTION_START);
        startServiceSafely(intent);
    }

    private void startServiceSafely(Intent intent) {
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void show(String message) {
        statusView.setVisibility(View.VISIBLE);
        statusView.setText(message);
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.1.0";
        }
    }

    /** Only shared when the owner opted in, and only launcher-resolvable apps. */
    private java.util.Set<String> launcherPackages() {
        java.util.Set<String> packages = new java.util.LinkedHashSet<>();
        Intent intent = new Intent(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        for (android.content.pm.ResolveInfo info :
                getPackageManager().queryIntentActivities(intent, 0)) {
            if (info.activityInfo != null && info.activityInfo.packageName != null) {
                packages.add(info.activityInfo.packageName);
            }
        }
        return packages;
    }
}

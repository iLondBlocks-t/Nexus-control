package com.nexus.phoneagent.service;

import android.accessibilityservice.AccessibilityService;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import com.nexus.phoneagent.executor.ActionExecutor;

/**
 * The only component that can touch the screen.
 *
 * It does nothing on its own: the connection service hands it one action at a
 * time through the executor, and it reports the outcome back. It refuses to
 * work while the keyguard or another secure window is on top.
 */
public class NexusAccessibilityService extends AccessibilityService {

    public static final String ACTION_STOP_ALL = "com.nexus.phoneagent.STOP_ALL";

    private static volatile NexusAccessibilityService instance;

    private ActionExecutor executor;

    private final BroadcastReceiver stopReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (ACTION_STOP_ALL.equals(intent != null ? intent.getAction() : null) && executor != null) {
                executor.requestStop();
            }
        }
    };

    public static NexusAccessibilityService instance() {
        return instance;
    }

    public static boolean isEnabled() {
        NexusAccessibilityService service = instance;
        return service != null && service.isConnected;
    }

    private volatile boolean isConnected;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        isConnected = true;
        executor = new ActionExecutor(this);
        IntentFilter filter = new IntentFilter(ACTION_STOP_ALL);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(stopReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(stopReceiver, filter);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Events are not processed in bulk: the executor reads the live window
        // when it needs it, which is always the freshest state.
    }

    @Override
    public void onInterrupt() {
        if (executor != null) {
            executor.requestStop();
        }
    }

    @Override
    public boolean onUnbind(Intent intent) {
        isConnected = false;
        if (executor != null) {
            executor.requestStop();
        }
        try {
            unregisterReceiver(stopReceiver);
        } catch (IllegalArgumentException ignored) {
            // Not registered; nothing to undo.
        }
        instance = null;
        return super.onUnbind(intent);
    }

    public ActionExecutor executor() {
        return executor;
    }

    public AccessibilityNodeInfo root() {
        if (!isConnected) {
            return null;
        }
        try {
            return getRootInActiveWindow();
        } catch (SecurityException e) {
            return null;
        }
    }

    public boolean performGlobal(int action) {
        if (!isConnected) {
            return false;
        }
        try {
            return performGlobalAction(action);
        } catch (SecurityException e) {
            return false;
        }
    }
}

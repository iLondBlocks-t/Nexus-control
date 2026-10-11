package com.nexus.phoneagent.ui;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.TextView;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.model.TaskRecord;

import java.util.ArrayList;
import java.util.List;

/** Recent tasks list. Plain BaseAdapter: no AndroidX, no RecyclerView. */
public final class TaskAdapter extends BaseAdapter {

    private final LayoutInflater inflater;
    private final List<TaskRecord> records = new ArrayList<>();

    public TaskAdapter(Context context) {
        this.inflater = LayoutInflater.from(context);
    }

    public void replace(List<TaskRecord> next) {
        records.clear();
        if (next != null) {
            records.addAll(next);
        }
        notifyDataSetChanged();
    }

    @Override
    public int getCount() {
        return records.size();
    }

    @Override
    public TaskRecord getItem(int position) {
        return records.get(position);
    }

    @Override
    public long getItemId(int position) {
        return position;
    }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        View view = convertView != null ? convertView : inflater.inflate(R.layout.item_task, parent, false);
        TaskRecord record = getItem(position);

        TextView instruction = view.findViewById(R.id.item_task_instruction);
        TextView meta = view.findViewById(R.id.item_task_meta);

        instruction.setText(record.instruction.isEmpty() ? record.taskId : record.instruction);
        long endedAt = record.endedAt > 0L ? record.endedAt : System.currentTimeMillis();
        meta.setText(Format.status(record.status) + " · " + Format.time(record.startedAt)
                + " · " + Format.duration(endedAt - record.startedAt));
        return view;
    }
}

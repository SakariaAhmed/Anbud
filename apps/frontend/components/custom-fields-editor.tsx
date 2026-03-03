"use client";

import { useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

interface CustomFieldRow {
  id: string;
  key: string;
  value: string;
}

function toRows(customFields: Record<string, string>): CustomFieldRow[] {
  return Object.entries(customFields).map(([key, value]) => ({
    id: `${key}-${Math.random().toString(16).slice(2)}`,
    key,
    value
  }));
}

export function CustomFieldsEditor({
  tenderId,
  initialCustomFields
}: {
  tenderId: string;
  initialCustomFields: Record<string, string>;
}) {
  const [rows, setRows] = useState<CustomFieldRow[]>(toRows(initialCustomFields));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  const payload = useMemo(() => {
    return rows.reduce<Record<string, string>>((acc, row) => {
      const key = row.key.trim();
      const value = row.value.trim();
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }, [rows]);

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: "",
        value: ""
      }
    ]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  function updateRow(id: string, field: "key" | "value", value: string) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  async function saveFields() {
    setSaving(true);
    setStatus("Saving custom fields...");

    try {
      const response = await fetch(`${API_BASE}/api/v1/tenders/${tenderId}/custom-fields`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: JSON.stringify({ custom_fields: payload })
      });

      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }

      setStatus("Custom fields updated.");
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="panel form-panel">
      <div className="custom-fields-header">
        <h2>Custom Fields</h2>
        <button className="ghost-btn" onClick={addRow} type="button">
          Add Field
        </button>
      </div>

      {rows.length ? (
        <div className="custom-fields-list">
          {rows.map((row) => (
            <div className="custom-field-row" key={row.id}>
              <input onChange={(event) => updateRow(row.id, "key", event.target.value)} placeholder="Field name" type="text" value={row.key} />
              <input onChange={(event) => updateRow(row.id, "value", event.target.value)} placeholder="Field value" type="text" value={row.value} />
              <button className="ghost-btn danger" onClick={() => removeRow(row.id)} type="button">
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="form-hint">No custom fields yet.</p>
      )}

      <div className="form-actions-row">
        <button disabled={saving} onClick={saveFields} type="button">
          {saving ? "Saving..." : "Save Fields"}
        </button>
      </div>

      <p className="form-status">{status}</p>
    </article>
  );
}

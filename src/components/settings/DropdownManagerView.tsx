import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Edit3, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { DropdownGroupKey, DropdownOptionItem } from '../../types/index.ts';
import { apiFetch } from '../../utils/api.ts';

interface GroupMeta {
  key: DropdownGroupKey;
  label: string;
}

export default function DropdownManagerView() {
  const { refreshDropdowns } = useDropdowns();
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [optionsByGroup, setOptionsByGroup] = useState<Record<string, DropdownOptionItem[]>>({});
  const [selectedGroup, setSelectedGroup] = useState<DropdownGroupKey>('task_status');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Add new option
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit inline
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  // Migration modal on 409 delete conflict
  const [migrateModal, setMigrateModal] = useState<{
    option: DropdownOptionItem;
    message: string;
    targetId: string;
  } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<{
        groups: GroupMeta[];
        optionsByGroup: Record<string, DropdownOptionItem[]>;
      }>('/api/dropdowns?include_inactive=1');
      setGroups(res.groups || []);
      setOptionsByGroup(res.optionsByGroup || {});
    } catch (err: any) {
      setError(err.message || 'Failed to load dropdown options');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const currentOptions = optionsByGroup[selectedGroup] || [];
  const currentGroupLabel = groups.find((g) => g.key === selectedGroup)?.label || selectedGroup;

  const handleAddOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setError('');
    setNotice('');
    setAdding(true);
    try {
      await apiFetch('/api/dropdowns', {
        method: 'POST',
        body: JSON.stringify({ group_key: selectedGroup, label: newLabel.trim(), is_active: true }),
      });
      setNewLabel('');
      setNotice(`Added "${newLabel.trim()}" to ${currentGroupLabel}.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async (opt: DropdownOptionItem) => {
    if (!editLabel.trim()) return;
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/dropdowns/${opt.id}`, {
        method: 'PUT',
        body: JSON.stringify({ label: editLabel.trim() }),
      });
      setEditingId(null);
      setNotice(`Updated "${opt.label}" to "${editLabel.trim()}" across existing records.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleActive = async (opt: DropdownOptionItem) => {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/dropdowns/${opt.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !opt.is_active }),
      });
      setNotice(`${opt.label} is now ${!opt.is_active ? 'Active' : 'Inactive'}.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= currentOptions.length) return;
    const reordered = [...currentOptions];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);
    setOptionsByGroup((prev) => ({ ...prev, [selectedGroup]: reordered }));
    try {
      await apiFetch('/api/dropdowns/reorder', {
        method: 'PATCH',
        body: JSON.stringify({
          group_key: selectedGroup,
          ordered_ids: reordered.map((o) => o.id),
        }),
      });
      await refreshDropdowns();
    } catch (err: any) {
      setError(err.message);
      loadAll();
    }
  };

  const handleDelete = async (opt: DropdownOptionItem, migrateToId?: number) => {
    setError('');
    setNotice('');
    try {
      const qs = migrateToId ? `?migrate_to_id=${migrateToId}` : '';
      await apiFetch(`/api/dropdowns/${opt.id}${qs}`, { method: 'DELETE' });
      setMigrateModal(null);
      setNotice(`Deleted "${opt.label}" from ${currentGroupLabel}.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      const msg = err.message || 'Delete failed';
      if (msg.includes('currently used by')) {
        const candidates = currentOptions.filter((c) => c.id !== opt.id);
        setMigrateModal({
          option: opt,
          message: msg,
          targetId: candidates[0] ? String(candidates[0].id) : '',
        });
      } else {
        setError(msg);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-display font-semibold text-slate-900 dark:text-white">
            Super Admin Dropdown Management
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Add, rename, reorder, activate/deactivate, or safely migrate dropdown options across all forms, filters, and workflows. Changes sync live.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3.5 text-xs rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3.5 text-xs rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="grid lg:grid-cols-12 gap-6">
        {/* Left: Group Selector */}
        <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-1 h-fit">
          <div className="px-3 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
            Configurable Dropdown Groups
          </div>
          {groups.map((g) => {
            const count = (optionsByGroup[g.key] || []).length;
            const active = selectedGroup === g.key;
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => {
                  setSelectedGroup(g.key);
                  setEditingId(null);
                  setError('');
                  setNotice('');
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium rounded-lg transition-colors cursor-pointer text-left ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <span>{g.label}</span>
                <span className={`font-mono tabular-nums ${active ? 'text-blue-100' : 'text-slate-400'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right: Options Manager */}
        <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {currentGroupLabel}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Core system workflow options cannot be deleted to protect workflow integrity, but custom options can be edited or deleted anytime.
              </p>
            </div>
          </div>

          <form onSubmit={handleAddOption} className="flex flex-wrap gap-2">
            <input
              type="text"
              required
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder={`Add new option to ${currentGroupLabel}...`}
              className="flex-1 min-w-[220px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={adding || !newLabel.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-60 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{adding ? 'Adding...' : 'Add Option'}</span>
            </button>
          </form>

          {loading ? (
            <div className="py-10 text-center text-xs text-slate-500">Loading dropdown options...</div>
          ) : currentOptions.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">No options configured in this group yet.</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              {currentOptions.map((opt, idx) => (
                <div
                  key={opt.id}
                  className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-xs font-mono text-slate-400 w-6 tabular-nums">{idx + 1}.</span>

                    {editingId === opt.id ? (
                      <div className="flex items-center gap-2 flex-1 max-w-sm">
                        <input
                          type="text"
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="flex-1 px-2.5 py-1.5 text-sm rounded-lg border border-blue-500 bg-white dark:bg-slate-950"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(opt)}
                          className="p-1.5 rounded bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                          title="Save Rename"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="p-1.5 rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                          title="Cancel"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 dark:text-white flex items-center gap-2">
                          <span className={!opt.is_active ? 'line-through text-slate-400' : ''}>{opt.label}</span>
                          {opt.is_system && (
                            <span className="text-[11px] font-medium text-blue-700 dark:text-blue-400">
                              Core Workflow
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {opt.is_active ? 'Active' : 'Inactive'}
                          {' · '}
                          {opt.usage && opt.usage.total > 0
                            ? `Used in ${opt.usage.details.join(', ')}`
                            : 'No records linked yet'}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleMove(idx, -1)}
                      disabled={idx === 0}
                      className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      title="Move Up"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMove(idx, 1)}
                      disabled={idx === currentOptions.length - 1}
                      className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      title="Move Down"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(opt.id);
                        setEditLabel(opt.label);
                      }}
                      className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      title="Rename Option"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleActive(opt)}
                      className={`px-2.5 py-1 text-xs font-medium rounded border cursor-pointer ${
                        opt.is_active
                          ? 'border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                          : 'border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                      }`}
                    >
                      {opt.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    {!opt.is_system && (
                      <button
                        type="button"
                        onClick={() => handleDelete(opt)}
                        className="p-1.5 rounded border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                        title="Delete Option"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Safe Deletion Migration Modal */}
      {migrateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Migrate Linked Records Before Deleting
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                  {migrateModal.message}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5">
                Move existing records to replacement option:
              </label>
              <select
                value={migrateModal.targetId}
                onChange={(e) => setMigrateModal({ ...migrateModal, targetId: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {currentOptions
                  .filter((o) => o.id !== migrateModal.option.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMigrateModal(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!migrateModal.targetId}
                onClick={() => handleDelete(migrateModal.option, Number(migrateModal.targetId))}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 cursor-pointer"
              >
                Migrate & Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

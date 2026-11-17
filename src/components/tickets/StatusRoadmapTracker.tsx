import React from 'react';
import { AlertTriangle, Check, Clock, HelpCircle, RotateCcw } from 'lucide-react';
import { formatDateTime, getStatusColorClass } from '../../utils/api.ts';

interface ActivityRow {
  id: number;
  actor_name: string;
  actor_role: string;
  action_type: string;
  previous_status?: string | null;
  new_status?: string | null;
  details?: string | null;
  created_at: string;
}

interface StatusRoadmapTrackerProps {
  status: string;
  activities: ActivityRow[];
}

const CORE_STEPS = [
  'Assigned',
  'Accepted',
  'Under Review',
  'In Progress',
  'Ready for Review',
  'Completed',
] as const;

export default function StatusRoadmapTracker({ status, activities }: StatusRoadmapTrackerProps) {
  const stepIndex = CORE_STEPS.indexOf(status as any);
  const isHoldBranch = status === 'On Hold' || status === 'Pending Information';
  const isRevisionBranch = status === 'Revision Required';

  // Estimate progression stage when currently in a pause/revision state
  let reachedIndex = stepIndex;
  if (reachedIndex === -1) {
    if (isHoldBranch) reachedIndex = 3; // paused during/around In Progress
    else if (isRevisionBranch) reachedIndex = 4; // came back from Ready for Review
    else if (status === 'New') reachedIndex = -1;
  }

  const statusChanges = activities.filter(
    (a) => a.new_status || a.action_type === 'STATUS_UPDATED' || a.action_type === 'ASSIGNED' || a.action_type === 'ADMIN_REVIEW' || a.action_type === 'MODERATOR_ACCEPTED'
  );

  return (
    <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold text-slate-900 dark:text-white">
            Work Status Roadmap
          </h4>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Final completion requires Super Admin approval after Ready for Review.
          </p>
        </div>
        <div className={`text-xs font-semibold ${getStatusColorClass(status)}`}>
          Current Stage: {status}
        </div>
      </div>

      {/* Main Stepper Progression */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {CORE_STEPS.map((step, idx) => {
          const isCurrent = status === step;
          const isDone = status === 'Completed' ? true : reachedIndex > idx;
          return (
            <div
              key={step}
              className={`px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                isCurrent
                  ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-800 dark:text-blue-200 font-semibold'
                  : isDone
                  ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[10px] tabular-nums">0{idx + 1}</span>
                {isDone && !isCurrent && <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />}
                {isCurrent && <Clock className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />}
              </div>
              <div className="mt-1 truncate">{step}</div>
            </div>
          );
        })}
      </div>

      {/* Active Hold / Pending Info / Revision Branch Indicator */}
      {(isHoldBranch || isRevisionBranch) && (
        <div
          className={`flex items-start gap-2.5 p-3 rounded-lg border text-xs ${
            isRevisionBranch
              ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
              : 'border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
          }`}
        >
          {isRevisionBranch ? (
            <RotateCcw className="w-4 h-4 shrink-0 mt-0.5" />
          ) : status === 'Pending Information' ? (
            <HelpCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <div>
            <div className="font-semibold">Workflow Branch Active: {status}</div>
            <div className="mt-0.5 opacity-90">
              {status === 'On Hold'
                ? 'Work is temporarily paused with a logged hold reason.'
                : status === 'Pending Information'
                ? 'Waiting for clarification or additional details from the Super Admin.'
                : 'Super Admin requested revisions before final completion approval.'}
            </div>
          </div>
        </div>
      )}

      {/* Chronological Status Transition History */}
      {statusChanges.length > 0 && (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
          <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-2">
            Status Transition Timeline
          </div>
          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {statusChanges.map((act) => (
              <div
                key={act.id}
                className="flex flex-wrap items-baseline justify-between gap-2 text-xs py-1.5 px-2.5 rounded bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-900 dark:text-white">{act.actor_name}</span>
                  <span className="text-slate-400 mx-1.5">·</span>
                  {act.previous_status && act.new_status ? (
                    <span>
                      <span className="text-slate-500">{act.previous_status}</span>
                      <span className="mx-1 text-slate-400">→</span>
                      <span className={getStatusColorClass(act.new_status)}>{act.new_status}</span>
                    </span>
                  ) : (
                    <span className="text-slate-600 dark:text-slate-300">{act.action_type}</span>
                  )}
                  {act.details && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 break-words">
                      {act.details}
                    </div>
                  )}
                </div>
                <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap shrink-0 tabular-nums">
                  {formatDateTime(act.created_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

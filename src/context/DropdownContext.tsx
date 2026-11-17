import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  ASSET_CATEGORIES,
  BUSINESS_IMPACT_LEVELS,
  DEVICE_TYPES,
  DropdownGroupKey,
  DropdownOptionItem,
  EXPENSE_CATEGORIES,
  ISSUE_CATEGORIES,
  PRIORITY_LEVELS,
  TICKET_STATUSES,
} from '../types/index.ts';
import { apiFetch } from '../utils/api.ts';
import { useAuth } from './AuthContext.tsx';

interface DropdownGroupMeta {
  key: DropdownGroupKey;
  label: string;
}

interface DropdownContextValue {
  groups: DropdownGroupMeta[];
  optionsByGroup: Record<string, DropdownOptionItem[]>;
  loading: boolean;
  getOptions: (groupKey: DropdownGroupKey) => string[];
  getOptionItems: (groupKey: DropdownGroupKey) => DropdownOptionItem[];
  refreshDropdowns: () => Promise<void>;
}

const FALLBACK_OPTIONS: Record<DropdownGroupKey, readonly string[]> = {
  task_status: TICKET_STATUSES,
  work_category: ISSUE_CATEGORIES,
  priority: PRIORITY_LEVELS,
  department: ['Warehouse Operations', 'Logistics & Fleet', 'IT & Infrastructure', 'Finance & Billing', 'HR & Admin', 'Customer Operations'],
  device_type: DEVICE_TYPES,
  business_impact: BUSINESS_IMPACT_LEVELS,
  asset_category: ASSET_CATEGORIES,
  expense_category: EXPENSE_CATEGORIES,
};

const DropdownContext = createContext<DropdownContextValue>({
  groups: [],
  optionsByGroup: {},
  loading: false,
  getOptions: (groupKey) => [...(FALLBACK_OPTIONS[groupKey] || [])],
  getOptionItems: () => [],
  refreshDropdowns: async () => {},
});

export function DropdownProvider({ children }: { children: React.ReactNode }) {
  const { user, subscribeRealtime } = useAuth();
  const [groups, setGroups] = useState<DropdownGroupMeta[]>([]);
  const [optionsByGroup, setOptionsByGroup] = useState<Record<string, DropdownOptionItem[]>>({});
  const [loading, setLoading] = useState(false);

  const refreshDropdowns = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await apiFetch<{
        groups: DropdownGroupMeta[];
        optionsByGroup: Record<string, DropdownOptionItem[]>;
      }>('/api/dropdowns');
      setGroups(data.groups || []);
      setOptionsByGroup(data.optionsByGroup || {});
    } catch {
      // keep fallback options if request fails transiently
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      refreshDropdowns();
    } else {
      setOptionsByGroup({});
    }
  }, [user, refreshDropdowns]);

  useEffect(() => {
    if (!user) return;
    return subscribeRealtime((evt) => {
      if (evt.event === 'dropdowns:updated') {
        refreshDropdowns();
      }
    });
  }, [user, subscribeRealtime, refreshDropdowns]);

  const getOptionItems = useCallback(
    (groupKey: DropdownGroupKey): DropdownOptionItem[] => {
      return optionsByGroup[groupKey] || [];
    },
    [optionsByGroup]
  );

  const getOptions = useCallback(
    (groupKey: DropdownGroupKey): string[] => {
      const list = optionsByGroup[groupKey];
      if (list && list.length > 0) {
        return list.filter((o) => o.is_active).map((o) => o.value);
      }
      return [...(FALLBACK_OPTIONS[groupKey] || [])];
    },
    [optionsByGroup]
  );

  return (
    <DropdownContext.Provider
      value={{
        groups,
        optionsByGroup,
        loading,
        getOptions,
        getOptionItems,
        refreshDropdowns,
      }}
    >
      {children}
    </DropdownContext.Provider>
  );
}

export function useDropdowns() {
  return useContext(DropdownContext);
}

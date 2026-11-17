export type RoleName = 'super_admin' | 'moderator' | 'employee' | 'management';

export const ISSUE_CATEGORIES = [
  'Laptop / Desktop Issues',
  'Printer and Scanner Issues',
  'CCTV Camera Issues',
  'Network / Internet Issues',
  'Wi-Fi Issues',
  'Warehouse Technical Equipment',
  'Barcode Scanner Issues',
  'Server and Software Issues',
  'ERP / WMS Application Issues',
  'Email / Outlook Issues',
  'Mobile Device Issues',
  'Biometric Attendance Systems',
  'UPS / Power Backup Issues',
  'Access Control Systems',
  'Other Technical Issues',
] as const;

export const ROADMAP_STATUSES = [
  'Assigned',
  'Accepted',
  'Under Review',
  'In Progress',
  'On Hold',
  'Pending Information',
  'Ready for Review',
  'Revision Required',
  'Completed',
] as const;

export const TICKET_STATUSES = [
  'New',
  'Assigned',
  'Accepted',
  'Under Review',
  'In Progress',
  'On Hold',
  'Pending Information',
  'Ready for Review',
  'Revision Required',
  'Completed',
  'Escalated',
  'Reopened',
] as const;

export const PRIORITY_LEVELS = ['Critical', 'High', 'Medium', 'Low'] as const;

export const BUSINESS_IMPACT_LEVELS = [
  'Single User',
  'Departmental',
  'Branch / Warehouse Wide',
  'Multi-Location',
] as const;

export const DEVICE_TYPES = [
  'Laptop',
  'Desktop',
  'Thermal / Laser Printer',
  'CCTV / NVR',
  'Router / Firewall',
  'Barcode / Handheld Scanner',
  'Warehouse Server',
  'UPS / Power Unit',
  'Biometric Terminal',
  'Other Equipment',
] as const;

export const ASSET_CATEGORIES = [
  'Laptop',
  'Desktop',
  'Printers',
  'CCTV Cameras',
  'Network Devices',
  'Barcode Scanners',
  'Servers',
  'UPS',
  'Routers',
  'Switches',
  'Other IT Equipment',
] as const;

export const EXPENSE_CATEGORIES = [
  'Hardware Purchase',
  'Repair & Maintenance',
  'Software Subscription',
  'Networking',
  'Vendor Payment',
  'Spare Parts',
  'Emergency IT',
] as const;

export type DropdownGroupKey =
  | 'task_status'
  | 'work_category'
  | 'priority'
  | 'department'
  | 'device_type'
  | 'business_impact'
  | 'asset_category'
  | 'expense_category';

export interface DropdownOptionItem {
  id: number;
  group_key: DropdownGroupKey;
  label: string;
  value: string;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  meta?: Record<string, any>;
  usage?: { total: number; details: string[] };
  created_at?: string;
  updated_at?: string;
}

export interface NotificationPrefs {
  enabled: boolean;
  popups_enabled: boolean;
}

export interface AdminPermissionPolicy {
  user_id?: number;
  is_unrestricted?: boolean;
  allowed_location_ids: number[];
  allowed_department_ids: number[];
  allowed_moderator_ids: number[];
  can_view_chats: boolean;
  can_monitor_chats: boolean;
  can_view_reports: boolean;
  can_manage_assets: boolean;
  can_view_budgets: boolean;
  can_manage_budgets: boolean;
  can_approve_expenses: boolean;
  can_export_data: boolean;
  can_manage_tickets: boolean;
}

export interface ChatAttachmentItem {
  id: number;
  message_id: number;
  original_name: string;
  file_name?: string;
  mime_type: string;
  file_size: number;
  file_category: 'image' | 'video' | 'document' | string;
  created_at: string;
}

export interface DirectMessageItem {
  id: number;
  sender_user_id: number;
  recipient_user_id: number;
  ticket_id?: number | null;
  ticket_number?: string | null;
  ticket_status?: string | null;
  message: string;
  is_read: number;
  read_at?: string | null;
  created_at: string;
  sender_name: string;
  sender_role: string;
  recipient_name?: string;
  attachments?: ChatAttachmentItem[];
}

export interface ChatConversationItem {
  user_id: number;
  full_name: string;
  email: string;
  role: RoleName;
  moderator_id?: number;
  employee_id?: number;
  employee_code?: string;
  specialization?: string;
  unread_count: number;
  last_message?: string | null;
  last_message_at?: string | null;
  is_online?: boolean;
}

export interface TicketAttachmentItem {
  id: number;
  ticket_id: number;
  file_name: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  media_category: 'Photo' | 'Video' | 'Document' | string;
  uploaded_by_name: string;
  uploaded_at: string;
}

export interface SavedReportItem {
  id: number;
  report_type: string;
  title: string;
  filters?: Record<string, any>;
  row_count: number;
  rows?: any[];
  created_by_user_id?: number;
  created_by_name: string;
  created_by_role: string;
  created_at: string;
}

export interface RetentionPolicyItem {
  id?: number;
  entity_key: 'chats' | 'reports' | 'media' | 'audit_logs' | string;
  retention_days: number;
  auto_archive: number;
  updated_at?: string | null;
}

export interface AssetHistoryItem {
  id: number;
  asset_id: number;
  event_type: string;
  previous_value?: string | null;
  new_value?: string | null;
  assigned_employee_id?: number | null;
  employee_name?: string | null;
  location_id?: number | null;
  location_name?: string | null;
  actor_user_id?: number | null;
  actor_name: string;
  notes?: string | null;
  created_at: string;
}

export interface AssetExcelImportResult {
  batchId: number;
  filename: string;
  totalRows: number;
  importedCount: number;
  failedCount: number;
  imported: Array<{ id: number; asset_tag: string; serial_number: string; device_name: string }>;
  errors: Array<{ row: number; asset_tag?: string; serial_number?: string; error: string }>;
}

export interface UserSession {
  id: number;
  email: string;
  full_name: string;
  role: RoleName;
  role_label: string;
  session_id: number;
  employee_id?: number | null;
  moderator_id?: number | null;
  must_reset_password?: boolean;
  mfa_enabled?: boolean;
  permissions?: AdminPermissionPolicy;
  notification_prefs?: NotificationPrefs | null;
  employee_profile?: any;
  moderator_profile?: any;
}

export interface LocationItem {
  id: number;
  code: string;
  name: string;
  type: string;
  city: string;
  state: string;
  address: string;
  manager_name?: string;
}

export interface DepartmentItem {
  id: number;
  name: string;
  code: string;
  cost_center?: string;
}

export interface TicketItem {
  id: number;
  ticket_number: string;
  employee_id?: number;
  created_by_user_id: number;
  reporter_name: string;
  reporter_employee_code: string;
  reporter_department: string;
  reporter_designation: string;
  reporter_mobile: string;
  reporter_email: string;
  reporter_branch_name: string;
  reporter_city: string;
  reporter_full_location: string;
  reporter_manager: string;
  location_id?: number;
  location_name?: string;
  location_code?: string;
  department_id?: number;
  department_name?: string;
  category: string;
  device_type: string;
  device_name: string;
  asset_id?: number;
  asset_tag?: string;
  asset_serial_input?: string;
  description: string;
  issue_occurred_at: string;
  business_impact: string;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  status: string;
  assigned_moderator_id?: number | null;
  moderator_name?: string;
  moderator_email?: string;
  moderator_phone?: string;
  moderator_role?: 'super_admin' | 'moderator';
  deadline_at?: string;
  sla_first_response_due?: string;
  sla_resolution_due?: string;
  sla_breached: number;
  first_response_at?: string;
  assigned_at?: string;
  accepted_at?: string;
  work_started_at?: string;
  work_completed_at?: string;
  resolved_at?: string;
  closed_at?: string;
  total_working_minutes: number;
  visit_count: number;
  parts_replaced?: string;
  expenses_incurred: number;
  resolution_description?: string;
  employee_feedback?: string;
  employee_confirmed: number;
  admin_verified: number;
  rejection_reason?: string;
  latest_comment?: string;
  latest_activity?: string;
  created_at: string;
  updated_at: string;
}

export interface ModeratorItem {
  id: number;
  user_id: number;
  assignee_role?: 'super_admin' | 'moderator';
  employee_code: string;
  full_name: string;
  email: string;
  phone: string;
  specialization: string;
  assigned_location_ids: number[];
  assigned_location_names: string[];
  date_of_joining: string;
  status: 'Active' | 'Inactive';
  performance_rating: number;
  max_capacity: number;
  current_workload: number;
  total_assigned: number;
  resolved_tickets: number;
  pending_tickets: number;
  reopened_tickets: number;
  overdue_tickets: number;
  avg_resolution_hours?: number | null;
  avg_first_response_mins?: number | null;
  total_working_minutes: number;
  last_login_at?: string;
  invite_token?: string | null;
  invited_link_base?: string | null;
  invite_expires_at?: string | null;
  must_reset_password?: number | boolean;
  tracked_action_count?: number;
  last_activity_at?: string | null;
}

export interface NotificationItem {
  id: number;
  user_id: number;
  ticket_id?: number | null;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'critical' | 'success';
  is_read: number;
  created_at: string;
}

export type BroadcastCategory = 'Important' | 'Announcement' | 'Warning' | 'Urgent' | 'General';
export type BroadcastDisplayMode = 'tab_only' | 'tab_and_popup';
export type BroadcastTargetAudience = 'everyone' | 'admins' | 'moderators' | 'employees' | 'selected';
export type BroadcastLifecycleStatus = 'published' | 'scheduled' | 'expired' | 'withdrawn';

export interface BroadcastNotificationItem {
  id: number;
  title: string;
  message: string;
  category: BroadcastCategory;
  display_mode: BroadcastDisplayMode;
  target_audience: BroadcastTargetAudience;
  target_user_ids: number[];
  attachment_path?: string | null;
  attachment_name?: string | null;
  attachment_mime?: string | null;
  starts_at?: string | null;
  expires_at?: string | null;
  is_active: number;
  lifecycle_status: BroadcastLifecycleStatus;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
  delivered_count: number;
  read_count: number;
  popup_seen_count: number;
}

export interface UserBroadcastItem {
  id: number;
  title: string;
  message: string;
  category: BroadcastCategory;
  display_mode: BroadcastDisplayMode;
  attachment_path?: string | null;
  attachment_name?: string | null;
  attachment_mime?: string | null;
  starts_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  created_by_name?: string;
  is_read: number;
  read_at?: string | null;
  popup_seen: number;
}

export interface WebsiteTrafficResponse {
  summary: {
    total_visits: number;
    unique_visitors: number;
    today_visits: number;
    yesterday_visits: number;
    weekly_visits: number;
    monthly_visits: number;
    yearly_visits: number;
    active_visitors_now: number;
    growth_pct: number | null;
  };
  trend: Array<{ period: string; visits: number; unique_visitors: number }>;
  top_pages: Array<{ page_path: string; visits: number; unique_visitors: number }>;
  referrers: Array<{ source: string; visits: number; unique_visitors: number }>;
  devices: Array<{ device_type: string; visits: number }>;
  recent_visits: Array<{
    visited_at: string;
    page_path: string;
    referrer: string;
    device_type: string;
    visitor_token: string;
  }>;
}


import bcrypt from 'bcryptjs';
import { db, syncDepartmentDropdownOptions } from './db.ts';

export function seedDatabaseIfEmpty() {
  const roleCount = db.prepare('SELECT COUNT(*) as count FROM roles').get() as { count: number };
  if (roleCount.count > 0) {
    return;
  }

  const insertSeed = db.transaction(() => {
    // 1. Roles
    const insertRole = db.prepare('INSERT INTO roles (name, label, description) VALUES (?, ?, ?)');
    const rAdmin = insertRole.run('super_admin', 'Super Admin / IT Head', 'Full platform, user, budget, SLA, asset, and integration governance').lastInsertRowid;
    insertRole.run('moderator', 'IT Moderator', 'Assigned ticket resolution, troubleshooting, time logging, and employee comms');
    insertRole.run('employee', 'Employee', 'Submit IT requests, upload evidence, track timeline, confirm or reopen');
    insertRole.run('management', 'Management (Read-Only)', 'Executive read-only access to dashboards, budgets, SLA, and reports');

    // 2. Locations
    const insertLoc = db.prepare('INSERT INTO locations (code, name, type, city, state, address, manager_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const locBhiwandi = insertLoc.run('WH-MUM-01', 'Bhiwandi Mega Fulfillment Hub', 'Warehouse', 'Mumbai', 'Maharashtra', 'Plot 14, Mankoli Logistics Park, Bhiwandi 421302', 'Rajesh Deshmukh').lastInsertRowid;
    const locDelhi = insertLoc.run('WH-DEL-02', 'NCR Automated Distribution Center', 'Warehouse', 'Gurugram', 'Haryana', 'Sector 82, NH-48 Logistics Corridor, Gurugram 122004', 'Vikram Malhotra').lastInsertRowid;
    const locBlr = insertLoc.run('BR-BLR-03', 'Bengaluru Cold-Chain Branch', 'Branch', 'Bengaluru', 'Karnataka', 'Peenya Industrial Area Phase II, Bengaluru 560058', 'Ananya Rao').lastInsertRowid;
    const locChn = insertLoc.run('HB-CHN-04', 'Chennai Port Container Terminal', 'Hub', 'Chennai', 'Tamil Nadu', 'Ennore Port Access Rd, Thiruvottiyur, Chennai 600019', 'Karthik Subramanian').lastInsertRowid;
    const locPune = insertLoc.run('OF-PUN-05', 'Pune Corporate & Fleet HQ', 'Corporate Office', 'Pune', 'Maharashtra', 'Tower B, Magarpatta Cybercity, Pune 411013', 'Meera Joshi').lastInsertRowid;
    const locHyd = insertLoc.run('WH-HYD-06', 'Hyderabad Shamshabad Cargo Hub', 'Warehouse', 'Hyderabad', 'Telangana', 'RGIA Cargo Logistics Zone, Shamshabad 501218', 'Srinivas Reddy').lastInsertRowid;

    // 3. Departments
    const insertDept = db.prepare('INSERT INTO departments (name, code, cost_center) VALUES (?, ?, ?)');
    insertDept.run('Warehouse Operations', 'OPS', 'CC-101');
    insertDept.run('Fleet & Dispatch', 'FLT', 'CC-102');
    insertDept.run('Inventory Control', 'INV', 'CC-103');
    insertDept.run('Finance & Billing', 'FIN', 'CC-104');
    insertDept.run('Human Resources', 'HRS', 'CC-105');
    insertDept.run('IT Infrastructure', 'INF', 'CC-100');

    // Password hash for Super Admin (supports SUPER_ADMIN_PASSWORD env override)
    const initialAdminPw = (process.env.SUPER_ADMIN_PASSWORD || '').trim() || 'Sdgl@!1234#';
    const defaultHash = bcrypt.hashSync(initialAdminPw, 10);

    // 4. Users — ONLY Super Admin is provisioned initially.
    // Moderators, Employees, and Management accounts are added by the Super Admin.
    const insertUser = db.prepare('INSERT INTO users (role_id, email, password_hash, full_name, status) VALUES (?, ?, ?, ?, ?)');
    const uAdmin = insertUser.run(rAdmin, 'techsupport@sdgloballogistics.com', defaultHash, 'Gaurav', 'Active').lastInsertRowid;

    // 5. SLA Configurations
    const insertSla = db.prepare(`
      INSERT INTO sla_configurations (priority, first_response_minutes, resolution_hours, working_hours_start, working_hours_end, holidays_json, auto_escalate, escalate_to_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSla.run('Critical', 15, 4, '00:00', '23:59', '["2026-01-26","2026-08-15","2026-10-02"]', 1, 'techsupport@sdgloballogistics.com');
    insertSla.run('High', 30, 8, '08:00', '20:00', '["2026-01-26","2026-08-15","2026-10-02"]', 1, 'techsupport@sdgloballogistics.com');
    insertSla.run('Medium', 240, 24, '09:00', '18:00', '["2026-01-26","2026-08-15","2026-10-02"]', 1, 'techsupport@sdgloballogistics.com');
    insertSla.run('Low', 480, 48, '09:00', '18:00', '["2026-01-26","2026-08-15","2026-10-02"]', 0, 'techsupport@sdgloballogistics.com');

    // 6. Vendors
    const insertVendor = db.prepare('INSERT INTO vendors (name, category, contact_person, phone, email, tax_id, address) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertVendor.run('Apex AutoID Solutions', 'Barcode Scanners & Thermal Printers', 'Harish Patel', '+91-22-4091-2200', 'support@apexautoid.example', '27AABCA1234D1Z5', 'Andheri East, Mumbai');
    insertVendor.run('NetGrid Telecom Systems', 'Cisco Networking & Wi-Fi', 'Nikhil Rao', '+91-11-4120-8800', 'noc@netgrid.example', '07AABCN5678E1Z2', 'Okhla Phase III, New Delhi');
    insertVendor.run('Sentinel Vision Tech', 'CCTV & Biometric Access Control', 'Ritu Malhotra', '+91-80-4990-1122', 'service@sentinelvision.example', '29AABCS9012F1Z9', 'Koramangala, Bengaluru');
    insertVendor.run('VoltEdge Power Systems', 'Industrial UPS & Backup', 'Karan Bhatia', '+91-44-2815-7744', 'amc@voltedge.example', '33AABCV3456G1Z1', 'Guindy, Chennai');

    // 7. IT Assets (unassigned hardware pool across logistics hubs)
    const insertAsset = db.prepare(`
      INSERT INTO it_assets (asset_tag, serial_number, category, brand, model, purchase_date, purchase_cost, warranty_expiry, assigned_employee_id, location_id, condition_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAsset.run('AST-SCN-1042', 'ZBR-MC9300-88412', 'Barcode Scanners', 'Zebra', 'MC9300 Ultra-Rugged Mobile Computer', '2025-02-14', 1850, '2028-02-14', null, locBhiwandi, 'Operational', 'Dock Bay 4 primary RF scanner');
    insertAsset.run('AST-PRT-2019', 'ZBR-ZT411-44109', 'Printers', 'Zebra', 'ZT411 Industrial Thermal Label Printer', '2024-09-10', 1420, '2027-09-10', null, locDelhi, 'Operational', 'Shipping lane 2 label station');
    insertAsset.run('AST-CAM-3088', 'HIK-NVR7632-9912', 'CCTV Cameras', 'Hikvision', 'DS-7632NI-K2 32-Ch NVR & Gate Array', '2024-05-20', 2400, '2027-05-20', null, locHyd, 'Operational', 'Bay 7-12 perimeter array');
    insertAsset.run('AST-NET-4011', 'CSC-C9200L-5521', 'Switches', 'Cisco', 'Catalyst 9200L 48-Port PoE+', '2024-01-15', 3800, '2029-01-15', null, locBhiwandi, 'Operational', 'Core MDF Rack A1');
    insertAsset.run('AST-UPS-5007', 'APC-SRT5K-7710', 'UPS', 'APC', 'Smart-UPS SRT 5000VA RM', '2023-11-05', 3100, '2026-11-05', null, locChn, 'Operational', 'Cold storage telemetry rack backup');
    insertAsset.run('AST-LTP-6033', 'DEL-5540-33219', 'Laptop', 'Dell', 'Latitude 5540 Business i7', '2025-06-01', 1290, '2028-06-01', null, locPune, 'Spare', 'Corporate HQ reserve workstation');
    insertAsset.run('AST-WIF-7012', 'UBQ-U6PRO-9021', 'Network Devices', 'Ubiquiti', 'UniFi U6 Enterprise Industrial AP', '2025-01-22', 320, '2027-01-22', null, locBlr, 'Operational', 'Cold aisle 3 wireless ceiling mount');
    insertAsset.run('AST-SRV-8001', 'DEL-R750-11029', 'Servers', 'Dell', 'PowerEdge R750xs Local WMS Cache', '2024-03-11', 6400, '2029-03-11', null, locDelhi, 'Operational', 'Local edge WMS node');

    // 8. IT Budgets (Annual & Location-wise for 2026)
    const insertBudget = db.prepare('INSERT INTO it_budgets (fiscal_year, month, location_id, allocated_amount, notes, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)');
    insertBudget.run(2026, 0, null, 240000, 'FY 2026 Company-Wide Annual IT Operations & Hardware Capex/Opex', uAdmin);
    insertBudget.run(2026, 0, locBhiwandi, 58000, 'Bhiwandi Mega Hub Annual IT Allocation', uAdmin);
    insertBudget.run(2026, 0, locDelhi, 52000, 'Delhi NCR Distribution Center Annual Allocation', uAdmin);
    insertBudget.run(2026, 0, locBlr, 34000, 'Bengaluru Cold-Chain Branch Annual Allocation', uAdmin);
    insertBudget.run(2026, 0, locChn, 32000, 'Chennai Port Terminal Annual Allocation', uAdmin);
    insertBudget.run(2026, 0, locPune, 36000, 'Pune Corporate & Fleet HQ Annual Allocation', uAdmin);
    insertBudget.run(2026, 0, locHyd, 28000, 'Hyderabad Cargo Hub Annual Allocation', uAdmin);

    // 9. Initial Audit Log
    db.prepare(
      'INSERT INTO audit_logs (user_id, user_email, role_name, action, entity_type, entity_id, details_json, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      uAdmin,
      'techsupport@sdgloballogistics.com',
      'super_admin',
      'SYSTEM_SEED',
      'system',
      'init',
      JSON.stringify({ note: 'Super Admin initialized; non-admin accounts must be provisioned by Super Admin' }),
      '127.0.0.1'
    );
  });

  insertSeed();
  syncDepartmentDropdownOptions();
}

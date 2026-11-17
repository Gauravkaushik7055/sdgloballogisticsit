import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export function exportToCsv(filename: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csvContent = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const val = row[h] === null || row[h] === undefined ? '' : String(row[h]);
          return `"${val.replace(/"/g, '""')}"`;
        })
        .join(',')
    ),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportToExcel(filename: string, sheetName: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 30));
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}

export function exportToPdf(filename: string, title: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(`SD Global IT CRM — ${title}`, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated: ${new Date().toLocaleString()}  ·  Records: ${rows.length}`, 40, 56);

  const headers = Object.keys(rows[0]).map((h) => h.replace(/_/g, ' ').toUpperCase());
  const body = rows.map((r) =>
    Object.keys(rows[0]).map((k) => {
      const v = r[k];
      return v === null || v === undefined ? '—' : String(v);
    })
  );

  autoTable(doc, {
    head: [headers],
    body,
    startY: 70,
    styles: { fontSize: 7.5, cellPadding: 4 },
    headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  doc.save(`${filename}.pdf`);
}

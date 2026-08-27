export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value !== ""));
}

export function encodeCsv(rows) {
  return `${rows.map((row) => row.map(encodeField).join(",")).join("\n")}\n`;
}

function encodeField(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function recordsFromCsv(text) {
  const [headers, ...rows] = parseCsv(text);
  if (!headers) return { headers: [], records: [] };
  const records = rows.map((row, rowIndex) => {
    if (row.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${row.length} columns; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  });
  return { headers, records };
}

export function recordsToCsv(headers, records) {
  return encodeCsv([headers, ...records.map((record) => headers.map((header) => record[header] ?? ""))]);
}

const EMPLOYEE_CODE_PATTERN = /^hrp-(\d{4})-(\d+)$/;

/** @typedef {{ id: string, name: string, group: "HRP" | "Vendor" }} RecruiterOption */

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function fold(value) {
  return value
    .toLocaleLowerCase("vi")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d");
}

export function formatEmployeeCode(startDate, suffix) {
  const match = isValidDate(startDate) ? /^(\d{4})/.exec(startDate) : null;
  if (!match) return `hrp-????-${suffix}`;
  return `hrp-${match[1]}-${suffix}`;
}

export function validateEmployeeCode(employeeCode, startDate, existingCodes = []) {
  const match = EMPLOYEE_CODE_PATTERN.exec(employeeCode);
  if (!match) return "Nhập mã theo dạng hrp-YYYY-số.";
  if (!isValidDate(startDate) || match[1] !== startDate.slice(0, 4)) {
    return "Năm trong mã phải khớp với ngày đầu tiên đi làm.";
  }
  if (existingCodes.includes(employeeCode)) return "Mã NLĐ bị trùng trong danh sách.";
  return null;
}

/** @type {RecruiterOption[]} */
export const recruiterOptions = [
  { id: "hrp-001", name: "Cao Ngọc Anh", group: "HRP" },
  { id: "hrp-002", name: "Cao Minh Châu", group: "HRP" },
  { id: "hrp-003", name: "Cao Thu Hà", group: "HRP" },
  { id: "hrp-004", name: "Châu Gia Linh", group: "HRP" },
  { id: "hrp-005", name: "Chi Nguyễn", group: "HRP" },
  { id: "hrp-006", name: "Chung Hải Yến", group: "HRP" },
  { id: "vendor-001", name: "Công ty An Tín", group: "Vendor" },
  { id: "vendor-002", name: "Công ty Bình Minh", group: "Vendor" },
  { id: "vendor-003", name: "Công ty Cầu Vồng", group: "Vendor" },
  { id: "vendor-004", name: "Công ty Đại Phát", group: "Vendor" },
  { id: "vendor-005", name: "Công ty Đông Á", group: "Vendor" },
  { id: "hrp-007", name: "Đặng Bảo Ngọc", group: "HRP" },
  { id: "vendor-006", name: "Đối tác Epsilon", group: "Vendor" },
  { id: "hrp-008", name: "Lê Thanh Mai", group: "HRP" },
  { id: "hrp-009", name: "Nguyễn Hoàng Yến", group: "HRP" },
];

export function searchRecruiters(query, group = "all") {
  const normalizedQuery = fold(query.trim());
  return recruiterOptions.filter((recruiter) => {
    const matchesGroup = group === "all" || recruiter.group === group;
    const matchesQuery =
      normalizedQuery === "" ||
      fold(recruiter.name).includes(normalizedQuery) ||
      fold(recruiter.group).includes(normalizedQuery);
    return matchesGroup && matchesQuery;
  });
}

export function parseClipboardMatrix(value) {
  const matrix = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      if (quoted && value[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === "\t") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\r" || char === "\n")) {
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = "";
      if (char === "\r" && value[index + 1] === "\n") index += 1;
    } else {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    matrix.push(row);
  }
  return matrix;
}

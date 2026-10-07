import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompanyDisplayNames,
  isSentinelProjectKey,
  shortCompanyName,
} from "./company-display-name.ts";

test("bo cac dang tien to phap ly pho bien", () => {
  assert.equal(shortCompanyName("Công ty TNHH ABC"), "ABC");
  assert.equal(shortCompanyName("Công ty TNHH MTV ABC"), "ABC");
  assert.equal(shortCompanyName("Công ty Cổ phần XYZ"), "XYZ");
  assert.equal(shortCompanyName("Công ty trách nhiệm hữu hạn DEF"), "DEF");
  assert.equal(shortCompanyName("CTCP DEF"), "DEF");
  assert.equal(shortCompanyName("CT TNHH GHI"), "GHI");
  assert.equal(shortCompanyName("TNHH JKL"), "JKL");
  assert.equal(shortCompanyName("Tập đoàn MNO"), "MNO");
  assert.equal(shortCompanyName("Tổng công ty PQR"), "PQR");
});

test("khong phan biet hoa thuong va giu nguyen phan ten rieng", () => {
  assert.equal(shortCompanyName("công ty tnhh Abc Việt Nam"), "Abc Việt Nam");
  assert.equal(shortCompanyName("CÔNG TY CP Thăng Long"), "Thăng Long");
  // Khong cat phan ten rieng: chi bo dung tien to.
  assert.equal(shortCompanyName("Công ty TNHH Công ty ABC"), "Công ty ABC");
});

test("ten von da ngan hoac khong khop tien to duoc tra ve nguyen ven", () => {
  for (const name of ["Compal", "CDL", "alpha_x", "FPT", "CtyABC", "Công ty"]) {
    assert.equal(shortCompanyName(name), name, name);
  }
  // "Công ty" mot minh: bo di se khong con ten rieng => giu nguyen.
  assert.equal(shortCompanyName("Công ty   "), "Công ty");
});

test("chuoi rong va sentinel duoc xu ly an toan", () => {
  assert.equal(shortCompanyName(""), "");
  assert.equal(shortCompanyName("   "), "   ");
  assert.equal(shortCompanyName("__unknown__"), "__unknown__");
  assert.equal(shortCompanyName("__invalid__"), "__invalid__");
  assert.equal(isSentinelProjectKey("__unknown__"), true);
  assert.equal(isSentinelProjectKey("Công ty TNHH ABC"), false);
});

test("gia tri alias (Ten hien thi) duoc uu tien hon viec bo tien to", () => {
  assert.equal(shortCompanyName("Công ty TNHH ABC", "ABC Group"), "ABC Group");
  // Alias rong/chi khoang trang => quay ve bo tien to.
  assert.equal(shortCompanyName("Công ty TNHH ABC", ""), "ABC");
  assert.equal(shortCompanyName("Công ty TNHH ABC", "   "), "ABC");
  assert.equal(shortCompanyName("Công ty TNHH ABC", null), "ABC");
  assert.equal(shortCompanyName("Công ty TNHH ABC", undefined), "ABC");
});

test("hai cong ty trung ten hien thi van phan biet duoc bang ten day du", () => {
  const resolved = buildCompanyDisplayNames([
    { key: "p1", fullName: "Công ty TNHH ABC" },
    { key: "p2", fullName: "Công ty Cổ phần ABC" },
    { key: "p3", fullName: "Công ty TNHH Riêng Biệt" },
  ]);
  // Trung ten gon "ABC" => ca hai dung ten day du, khong gop nhan.
  assert.equal(resolved.get("p1"), "Công ty TNHH ABC");
  assert.equal(resolved.get("p2"), "Công ty Cổ phần ABC");
  // Khong trung => dung ten gon.
  assert.equal(resolved.get("p3"), "Riêng Biệt");
  // Khoa lien ket khong doi.
  assert.deepEqual([...resolved.keys()].sort(), ["p1", "p2", "p3"]);
});

test("trung ten voi alias van duoc xu ly", () => {
  const resolved = buildCompanyDisplayNames([
    { key: "a", fullName: "Công ty TNHH ABC", displayName: "ABC Group" },
    { key: "b", fullName: "Công ty Cổ phần ABC", displayName: "ABC Group" },
    { key: "c", fullName: "Công ty TNHH Khác", displayName: "Khác Group" },
  ]);
  assert.equal(resolved.get("a"), "Công ty TNHH ABC");
  assert.equal(resolved.get("b"), "Công ty Cổ phần ABC");
  assert.equal(resolved.get("c"), "Khác Group");
});

test("khong bao gio tra ve chuoi rong cho mot ten co noi dung", () => {
  for (const name of ["Công ty TNHH A", "Công ty", "CTCP", "TNHH", "Tập đoàn"]) {
    const out = shortCompanyName(name);
    assert.notEqual(out.trim(), "", name + " -> rong");
  }
});

export interface VietQrBankCatalogDefinition {
  readonly bank_id: string;
  readonly bank_code: string;
  readonly short_name: string;
  readonly official_name: string;
  readonly bin: string;
  readonly aliases?: readonly string[];
}

export interface BankCatalogEntryInput {
  readonly bank_id: string;
  readonly display_name: string;
}

export interface MergedBankCatalogOption {
  readonly bank_id: string;
  readonly bank_code: string;
  readonly short_name: string;
  readonly official_name: string;
  readonly display_name: string;
  readonly label: string;
  readonly keywords: string;
}

/**
 * Canonical VietQR bank catalog sourced from:
 * https://api.vietqr.vn/vi/danh-sach-ma-ngan-hang
 * and https://api.vietqr.io/v2/banks
 *
 * `bank_id` uses stable canonical identifiers matching
 * `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
 */
export const VIETQR_BANK_CATALOG: readonly VietQrBankCatalogDefinition[] = [
  {
    bank_id: "ICB",
    bank_code: "ICB",
    short_name: "VietinBank",
    official_name: "Ngân hàng TMCP Công thương Việt Nam",
    bin: "970415",
    aliases: ["CTG", "VIETINBANK"],
  },
  {
    bank_id: "VCB",
    bank_code: "VCB",
    short_name: "Vietcombank",
    official_name: "Ngân hàng TMCP Ngoại Thương Việt Nam",
    bin: "970436",
    aliases: ["VIETCOMBANK"],
  },
  {
    bank_id: "BIDV",
    bank_code: "BIDV",
    short_name: "BIDV",
    official_name: "Ngân hàng TMCP Đầu tư và Phát triển Việt Nam",
    bin: "970418",
  },
  {
    bank_id: "VBA",
    bank_code: "VBA",
    short_name: "Agribank",
    official_name: "Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam",
    bin: "970405",
    aliases: ["AGRIBANK", "VBARD"],
  },
  {
    bank_id: "OCB",
    bank_code: "OCB",
    short_name: "OCB",
    official_name: "Ngân hàng TMCP Phương Đông",
    bin: "970448",
    aliases: ["PHUONG DONG"],
  },
  {
    bank_id: "MB",
    bank_code: "MB",
    short_name: "MBBank",
    official_name: "Ngân hàng TMCP Quân đội",
    bin: "970422",
    aliases: ["MBBANK", "QUAN DOI"],
  },
  {
    bank_id: "TCB",
    bank_code: "TCB",
    short_name: "Techcombank",
    official_name: "Ngân hàng TMCP Kỹ thương Việt Nam",
    bin: "970407",
    aliases: ["TECHCOMBANK", "KY THUONG"],
  },
  {
    bank_id: "ACB",
    bank_code: "ACB",
    short_name: "ACB",
    official_name: "Ngân hàng TMCP Á Châu",
    bin: "970416",
    aliases: ["A CHAU"],
  },
  {
    bank_id: "VPB",
    bank_code: "VPB",
    short_name: "VPBank",
    official_name: "Ngân hàng TMCP Việt Nam Thịnh Vượng",
    bin: "970432",
    aliases: ["VPBANK", "VIET NAM THINH VUONG"],
  },
  {
    bank_id: "TPB",
    bank_code: "TPB",
    short_name: "TPBank",
    official_name: "Ngân hàng TMCP Tiên Phong",
    bin: "970423",
    aliases: ["TPBANK", "TIEN PHONG"],
  },
  {
    bank_id: "STB",
    bank_code: "STB",
    short_name: "Sacombank",
    official_name: "Ngân hàng TMCP Sài Gòn Thương Tín",
    bin: "970403",
    aliases: ["SACOMBANK", "SAI GON THUONG TIN"],
  },
  {
    bank_id: "HDB",
    bank_code: "HDB",
    short_name: "HDBank",
    official_name: "Ngân hàng TMCP Phát triển Thành phố Hồ Chí Minh",
    bin: "970437",
    aliases: ["HDBANK"],
  },
  {
    bank_id: "VCCB",
    bank_code: "VCCB",
    short_name: "VietCapitalBank",
    official_name: "Ngân hàng TMCP Bản Việt",
    bin: "970454",
    aliases: ["BVBANK", "BAN VIET", "VIETCAPITALBANK"],
  },
  {
    bank_id: "SCB",
    bank_code: "SCB",
    short_name: "SCB",
    official_name: "Ngân hàng TMCP Sài Gòn",
    bin: "970429",
    aliases: ["SAI GON"],
  },
  {
    bank_id: "VIB",
    bank_code: "VIB",
    short_name: "VIB",
    official_name: "Ngân hàng TMCP Quốc tế Việt Nam",
    bin: "970441",
    aliases: ["QUOC TE VIET NAM"],
  },
  {
    bank_id: "SHB",
    bank_code: "SHB",
    short_name: "SHB",
    official_name: "Ngân hàng TMCP Sài Gòn - Hà Nội",
    bin: "970443",
    aliases: ["SAI GON HA NOI"],
  },
  {
    bank_id: "EIB",
    bank_code: "EIB",
    short_name: "Eximbank",
    official_name: "Ngân hàng TMCP Xuất Nhập khẩu Việt Nam",
    bin: "970431",
    aliases: ["EXIMBANK", "XUAT NHAP KHAU"],
  },
  {
    bank_id: "MSB",
    bank_code: "MSB",
    short_name: "MSB",
    official_name: "Ngân hàng TMCP Hàng Hải Việt Nam",
    bin: "970426",
    aliases: ["MARITIMEBANK", "HANG HAI"],
  },
  {
    bank_id: "CAKE",
    bank_code: "CAKE",
    short_name: "CAKE",
    official_name: "TMCP Việt Nam Thịnh Vượng - Ngân hàng số CAKE by VPBank",
    bin: "546034",
    aliases: ["CAKE BY VPBANK"],
  },
  {
    bank_id: "UBANK",
    bank_code: "Ubank",
    short_name: "Ubank",
    official_name: "TMCP Việt Nam Thịnh Vượng - Ngân hàng số Ubank by VPBank",
    bin: "546035",
    aliases: ["UBANK BY VPBANK"],
  },
  {
    bank_id: "VIKKI",
    bank_code: "VIKKI",
    short_name: "Vikki",
    official_name: "Ngân hàng TNHH MTV Số Vikki",
    bin: "970406",
    aliases: ["DONGABANK", "DAB", "DONG A", "VIKKI BY HDBANK"],
  },
  {
    bank_id: "TIMO",
    bank_code: "TIMO",
    short_name: "Timo",
    official_name: "Ngân hàng số Timo by Ban Viet Bank (Timo by Ban Viet Bank)",
    bin: "963388",
    aliases: ["TIMO BY BAN VIET BANK"],
  },
  {
    bank_id: "VNPTMONEY",
    bank_code: "VNPTMONEY",
    short_name: "VNPTMoney",
    official_name:
      "Trung tâm Dịch vụ tài chính số VNPT - Chi nhánh Tổng công ty truyền thông",
    bin: "971011",
    aliases: ["VNPT MONEY"],
  },
  {
    bank_id: "VIETTEL_PAY",
    bank_code: "VIETTEL PAY",
    short_name: "ViettelMoney",
    official_name:
      "Tổng Công ty Dịch vụ số Viettel - Chi nhánh tập đoàn công nghiệp viễn thông Quân Đội",
    bin: "971005",
    aliases: ["VIETTELMONEY", "VIETTEL MONEY", "VIETTELPAY"],
  },
  {
    bank_id: "SGICB",
    bank_code: "SGICB",
    short_name: "SaigonBank",
    official_name: "Ngân hàng TMCP Sài Gòn Công Thương",
    bin: "970400",
    aliases: ["SAIGONBANK", "SAI GON CONG THUONG"],
  },
  {
    bank_id: "BAB",
    bank_code: "BAB",
    short_name: "BacABank",
    official_name: "Ngân hàng TMCP Bắc Á",
    bin: "970409",
    aliases: ["BACABANK", "BAC A"],
  },
  {
    bank_id: "PVCB",
    bank_code: "PVCB",
    short_name: "PVcomBank",
    official_name: "Ngân hàng TMCP Đại Chúng Việt Nam",
    bin: "970412",
    aliases: ["PVCOMBANK", "DAI CHUNG"],
  },
  {
    bank_id: "PVDB",
    bank_code: "PVDB",
    short_name: "PVcomBank Pay",
    official_name: "Ngân hàng TMCP Đại Chúng Việt Nam Ngân hàng số",
    bin: "971133",
    aliases: ["PVCOMBANK PAY"],
  },
  {
    bank_id: "PBVN",
    bank_code: "PBVN",
    short_name: "PublicBank",
    official_name: "Ngân hàng TNHH MTV Public Việt Nam",
    bin: "970439",
    aliases: ["PUBLICBANK", "PUBLIC BANK", "VID PUBLIC"],
  },
  {
    bank_id: "MBV",
    bank_code: "MBV",
    short_name: "MBV",
    official_name: "Ngân hàng TNHH MTV Việt Nam Hiện Đại",
    bin: "970414",
    aliases: ["OCEANBANK", "DAI DUONG", "VIET NAM HIEN DAI"],
  },
  {
    bank_id: "NCB",
    bank_code: "NCB",
    short_name: "NCB",
    official_name: "Ngân hàng TMCP Quốc Dân",
    bin: "970419",
    aliases: ["QUOC DAN"],
  },
  {
    bank_id: "SHBVN",
    bank_code: "SHBVN",
    short_name: "ShinhanBank",
    official_name: "Ngân hàng TNHH MTV Shinhan Việt Nam",
    bin: "970424",
    aliases: ["SHINHAN", "SHINHANBANK"],
  },
  {
    bank_id: "ABB",
    bank_code: "ABB",
    short_name: "ABBANK",
    official_name: "Ngân hàng TMCP An Bình",
    bin: "970425",
    aliases: ["ABBANK", "AN BINH"],
  },
  {
    bank_id: "VAB",
    bank_code: "VAB",
    short_name: "VietABank",
    official_name: "Ngân hàng TMCP Việt Á",
    bin: "970427",
    aliases: ["VIETABANK", "VIET A"],
  },
  {
    bank_id: "NAB",
    bank_code: "NAB",
    short_name: "NamABank",
    official_name: "Ngân hàng TMCP Nam Á",
    bin: "970428",
    aliases: ["NAMABANK", "NAM A"],
  },
  {
    bank_id: "PGB",
    bank_code: "PGB",
    short_name: "PGBank",
    official_name: "Ngân hàng TMCP Thịnh vượng và Phát triển",
    bin: "970430",
    aliases: ["PGBANK", "XANG DAU PETROLIMEX"],
  },
  {
    bank_id: "VIETBANK",
    bank_code: "VIETBANK",
    short_name: "VietBank",
    official_name: "Ngân hàng TMCP Việt Nam Thương Tín",
    bin: "970433",
    aliases: ["VIET NAM THUONG TIN"],
  },
  {
    bank_id: "BVB",
    bank_code: "BVB",
    short_name: "BaoVietBank",
    official_name: "Ngân hàng TMCP Bảo Việt",
    bin: "970438",
    aliases: ["BAOVIETBANK", "BAO VIET"],
  },
  {
    bank_id: "SEAB",
    bank_code: "SEAB",
    short_name: "SeABank",
    official_name: "Ngân hàng TMCP Đông Nam Á",
    bin: "970440",
    aliases: ["SEABANK", "DONG NAM A"],
  },
  {
    bank_id: "COOPBANK",
    bank_code: "COOPBANK",
    short_name: "COOPBANK",
    official_name: "Ngân hàng Hợp tác xã Việt Nam",
    bin: "970446",
    aliases: ["HOP TAC XA"],
  },
  {
    bank_id: "LPB",
    bank_code: "LPB",
    short_name: "LPBank",
    official_name: "Ngân hàng TMCP Lộc Phát Việt Nam",
    bin: "970449",
    aliases: ["LPBANK", "LIENVIETPOSTBANK", "LOC PHAT", "BUU DIEN LIEN VIET"],
  },
  {
    bank_id: "KLB",
    bank_code: "KLB",
    short_name: "KienLongBank",
    official_name: "Ngân hàng TMCP Kiên Long",
    bin: "970452",
    aliases: ["KIENLONGBANK", "KIEN LONG"],
  },
  {
    bank_id: "KBANK",
    bank_code: "KBank",
    short_name: "KBank",
    official_name: "Ngân hàng Đại chúng TNHH Kasikornbank",
    bin: "668888",
    aliases: ["KASIKORNBANK", "KBANK HCM"],
  },
  {
    bank_id: "KBHN",
    bank_code: "KBHN",
    short_name: "KookminHN",
    official_name: "Ngân hàng Kookmin - Chi nhánh Hà Nội",
    bin: "970462",
    aliases: ["KOOKMIN HN", "KOOKMIN HA NOI"],
  },
  {
    bank_id: "KBHCM",
    bank_code: "KBHCM",
    short_name: "KookminHCM",
    official_name: "Ngân hàng Kookmin - Chi nhánh Thành phố Hồ Chí Minh",
    bin: "970463",
    aliases: ["KOOKMIN HCM", "KOOKMIN HO CHI MINH"],
  },
  {
    bank_id: "KEBHANAHCM",
    bank_code: "KEBHANAHCM",
    short_name: "KEBHanaHCM",
    official_name: "Ngân hàng KEB Hana – Chi nhánh Thành phố Hồ Chí Minh",
    bin: "970466",
    aliases: ["KEB HANA HCM"],
  },
  {
    bank_id: "KEBHANAHN",
    bank_code: "KEBHANAHN",
    short_name: "KEBHanaHN",
    official_name: "Ngân hàng KEB Hana – Chi nhánh Hà Nội",
    bin: "970467",
    aliases: ["KEBHN", "KEB HANA HN", "KEB HANA HA NOI"],
  },
  {
    bank_id: "MAFC",
    bank_code: "MAFC",
    short_name: "MAFC",
    official_name: "Công ty Tài chính TNHH MTV Mirae Asset (Việt Nam)",
    bin: "977777",
    aliases: ["MIRAE ASSET"],
  },
  {
    bank_id: "CITIBANK",
    bank_code: "CITIBANK",
    short_name: "Citibank",
    official_name: "Ngân hàng Citibank, N.A. - Chi nhánh Hà Nội",
    bin: "533948",
    aliases: ["CITI"],
  },
  {
    bank_id: "VBSP",
    bank_code: "VBSP",
    short_name: "VBSP",
    official_name: "Ngân hàng Chính sách Xã hội",
    bin: "999888",
    aliases: ["CHINH SACH XA HOI"],
  },
  {
    bank_id: "CBB",
    bank_code: "CBB",
    short_name: "CBBank",
    official_name: "Ngân hàng Thương mại TNHH MTV Xây dựng Việt Nam",
    bin: "970444",
    aliases: ["CBBANK", "XAY DUNG", "VNCB"],
  },
  {
    bank_id: "CIMB",
    bank_code: "CIMB",
    short_name: "CIMB",
    official_name: "Ngân hàng TNHH MTV CIMB Việt Nam",
    bin: "422589",
    aliases: ["CIMB VIET NAM"],
  },
  {
    bank_id: "DBS",
    bank_code: "DBS",
    short_name: "DBSBank",
    official_name: "DBS Bank Ltd - Chi nhánh Thành phố Hồ Chí Minh",
    bin: "796500",
    aliases: ["DBSBANK"],
  },
  {
    bank_id: "GPB",
    bank_code: "GPB",
    short_name: "GPBank",
    official_name: "Ngân hàng Thương mại TNHH MTV Dầu Khí Toàn Cầu",
    bin: "970408",
    aliases: ["GPBANK", "DAU KHI TOAN CAU"],
  },
  {
    bank_id: "HLBVN",
    bank_code: "HLBVN",
    short_name: "HongLeong",
    official_name: "Ngân hàng TNHH MTV Hong Leong Việt Nam",
    bin: "970442",
    aliases: ["HONGLEONG", "HONG LEONG"],
  },
  {
    bank_id: "HSBC",
    bank_code: "HSBC",
    short_name: "HSBC",
    official_name: "Ngân hàng TNHH MTV HSBC (Việt Nam)",
    bin: "458761",
  },
  {
    bank_id: "IBKHN",
    bank_code: "IBK - HN",
    short_name: "IBKHN",
    official_name: "Ngân hàng Công nghiệp Hàn Quốc - Chi nhánh Hà Nội",
    bin: "970455",
    aliases: ["IBK", "IBK HN"],
  },
  {
    bank_id: "IBKHCM",
    bank_code: "IBK - HCM",
    short_name: "IBKHCM",
    official_name: "Ngân hàng Công nghiệp Hàn Quốc - Chi nhánh TP. Hồ Chí Minh",
    bin: "970456",
    aliases: ["IBK HCM"],
  },
  {
    bank_id: "IVB",
    bank_code: "IVB",
    short_name: "IndovinaBank",
    official_name: "Ngân hàng TNHH Indovina",
    bin: "970434",
    aliases: ["INDOVINABANK", "INDOVINA"],
  },
  {
    bank_id: "NHB_HN",
    bank_code: "NHB HN",
    short_name: "Nonghyup",
    official_name: "Ngân hàng Nonghyup - Chi nhánh Hà Nội",
    bin: "801011",
    aliases: ["NONGHYUP", "NHB"],
  },
  {
    bank_id: "SCVN",
    bank_code: "SCVN",
    short_name: "StandardChartered",
    official_name: "Ngân hàng TNHH MTV Standard Chartered Bank Việt Nam",
    bin: "970410",
    aliases: ["STANDARD CHARTERED", "STANDARDCHARTERED"],
  },
  {
    bank_id: "UOB",
    bank_code: "UOB",
    short_name: "UnitedOverseas",
    official_name: "Ngân hàng United Overseas - Chi nhánh TP. Hồ Chí Minh",
    bin: "970458",
    aliases: ["UNITED OVERSEAS", "UNITEDOVERSEAS"],
  },
  {
    bank_id: "VRB",
    bank_code: "VRB",
    short_name: "VRB",
    official_name: "Ngân hàng Liên doanh Việt - Nga",
    bin: "970421",
    aliases: ["VIET NGA"],
  },
  {
    bank_id: "WVN",
    bank_code: "WVN",
    short_name: "Woori",
    official_name: "Ngân hàng TNHH MTV Woori Việt Nam",
    bin: "970457",
    aliases: ["WRB", "WOORI", "WOORIBANK"],
  },
  {
    bank_id: "LIOBANK",
    bank_code: "LioBank",
    short_name: "Liobank",
    official_name: "Ngân hàng số Liobank by OCB",
    bin: "963369",
    aliases: ["LIOBANK BY OCB"],
  },
  {
    bank_id: "UMEE",
    bank_code: "UMEE",
    short_name: "Umee",
    official_name: "Ngân hàng số Umee by Kienlongbank",
    bin: "963399",
    aliases: ["UMEE BY KIENLONGBANK"],
  },
  {
    bank_id: "VDB",
    bank_code: "VDB",
    short_name: "VDB",
    official_name: "Ngân hàng Phát triển Việt Nam",
    bin: "970460",
    aliases: ["PHAT TRIEN VIET NAM"],
  },
  {
    bank_id: "BNPHN",
    bank_code: "BNPHN",
    short_name: "BNPParibasHN",
    official_name: "Ngân hàng BNP Paribas - Chi nhánh Hà Nội",
    bin: "963668",
    aliases: ["BNP PARIBAS HN"],
  },
  {
    bank_id: "BNPHCM",
    bank_code: "BNPHCM",
    short_name: "BNPParibasHCM",
    official_name: "Ngân hàng BNP Paribas - Chi nhánh TP. Hồ Chí Minh",
    bin: "963666",
    aliases: ["BNP PARIBAS HCM"],
  },
  {
    bank_id: "CUB",
    bank_code: "cathay",
    short_name: "CathayBank",
    official_name: "Ngân hàng Cathay United Bank - Chi nhánh TP. Hồ Chí Minh",
    bin: "963366",
    aliases: ["CATHAY", "CATHAY UNITED BANK"],
  },
  {
    bank_id: "CFC",
    bank_code: "CFC",
    short_name: "VietCredit",
    official_name: "Công ty Tài chính Cổ phần Tín Việt",
    bin: "970465",
    aliases: ["VIETCREDIT", "TIN VIET"],
  },
  {
    bank_id: "ZALOPAY",
    bank_code: "ZALOPAY",
    short_name: "ZaloPay",
    official_name: "Ví điện tử ZaloPay",
    bin: "963386",
  },
  {
    bank_id: "VETC",
    bank_code: "VETC",
    short_name: "VETC",
    official_name: "Ví điện tử VETC",
    bin: "963368",
  },
  {
    bank_id: "MOMO",
    bank_code: "MOMO",
    short_name: "MoMo",
    official_name: "Ví điện tử MoMo",
    bin: "971025",
  },
  {
    bank_id: "VNPAY",
    bank_code: "VNPAY",
    short_name: "VNPAY",
    official_name: "Ví điện tử VNPAY",
    bin: "971018",
  },
] as const;

function normalizeBankLookupToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildOptionLabel(
  shortName: string,
  bankCode: string,
  officialName: string,
): string {
  const trimmedShort = shortName.trim();
  const trimmedCode = bankCode.trim();
  const trimmedOfficial = officialName.trim();

  const prefix =
    trimmedShort.toLowerCase() === trimmedCode.toLowerCase()
      ? trimmedShort
      : `${trimmedShort} (${trimmedCode})`;

  if (
    !trimmedOfficial ||
    trimmedOfficial.toLowerCase() === trimmedShort.toLowerCase()
  ) {
    return prefix;
  }
  return `${prefix} — ${trimmedOfficial}`;
}

function matchesVietQrDefinition(
  existing: BankCatalogEntryInput,
  def: VietQrBankCatalogDefinition,
): boolean {
  const idNorm = normalizeBankLookupToken(existing.bank_id);
  const nameNorm = normalizeBankLookupToken(existing.display_name);

  const defTokens = [
    def.bank_id,
    def.bank_code,
    def.short_name,
    def.official_name,
    ...(def.aliases ?? []),
  ].map(normalizeBankLookupToken);

  return defTokens.includes(idNorm) || (nameNorm.length > 0 && defTokens.includes(nameNorm));
}

/**
 * Merges an existing bank catalog (e.g. from `/api/direct-entry/catalog`) with
 * the canonical VietQR bank catalog:
 * - Preserves every existing `bank_id` unchanged.
 * - Enriches existing entries that correspond to a VietQR bank with its code,
 *   common/short name, official name, and aliases so searching by code (e.g. "TCB"),
 *   common name ("Techcombank"), or official name resolves to the exact same bank.
 * - Appends all missing VietQR banks with their stable canonical `bank_id`.
 */
export function mergeVietQrBankCatalog(
  existingBanks: readonly BankCatalogEntryInput[] = [],
): MergedBankCatalogOption[] {
  const result: MergedBankCatalogOption[] = [];
  const matchedVietQrIds = new Set<string>();
  const seenBankIds = new Set<string>();

  for (const existing of existingBanks) {
    const bankId = existing.bank_id.trim();
    if (!bankId || seenBankIds.has(bankId)) continue;
    seenBankIds.add(bankId);

    const matchedDef = VIETQR_BANK_CATALOG.find(
      (def) =>
        !matchedVietQrIds.has(def.bank_id) &&
        matchesVietQrDefinition(existing, def),
    );

    if (matchedDef) {
      matchedVietQrIds.add(matchedDef.bank_id);
      const label = buildOptionLabel(
        matchedDef.short_name,
        matchedDef.bank_code,
        matchedDef.official_name,
      );
      const keywords = [
        bankId,
        existing.display_name,
        matchedDef.bank_id,
        matchedDef.bank_code,
        matchedDef.short_name,
        matchedDef.official_name,
        matchedDef.bin,
        ...(matchedDef.aliases ?? []),
      ].join(" ");
      result.push({
        bank_id: bankId,
        bank_code: matchedDef.bank_code,
        short_name: matchedDef.short_name,
        official_name: matchedDef.official_name,
        display_name: existing.display_name.trim() || matchedDef.short_name,
        label,
        keywords,
      });
    } else {
      const displayName = existing.display_name.trim() || bankId;
      result.push({
        bank_id: bankId,
        bank_code: bankId,
        short_name: displayName,
        official_name: displayName,
        display_name: displayName,
        label:
          displayName.toLowerCase() === bankId.toLowerCase()
            ? displayName
            : `${displayName} (${bankId})`,
        keywords: `${bankId} ${displayName}`,
      });
    }
  }

  for (const def of VIETQR_BANK_CATALOG) {
    if (matchedVietQrIds.has(def.bank_id) || seenBankIds.has(def.bank_id)) {
      continue;
    }
    seenBankIds.add(def.bank_id);
    const label = buildOptionLabel(
      def.short_name,
      def.bank_code,
      def.official_name,
    );
    const keywords = [
      def.bank_id,
      def.bank_code,
      def.short_name,
      def.official_name,
      def.bin,
      ...(def.aliases ?? []),
    ].join(" ");
    result.push({
      bank_id: def.bank_id,
      bank_code: def.bank_code,
      short_name: def.short_name,
      official_name: def.official_name,
      display_name: def.short_name,
      label,
      keywords,
    });
  }

  return result;
}

/**
 * Resolves a bank option by `bank_id`, `bank_code`, `short_name`, `official_name`,
 * or display label. Returns `null` if the input does not match a known catalog bank.
 */
export function resolveBankCatalogOption(
  options: readonly MergedBankCatalogOption[],
  rawInput: string | null | undefined,
): MergedBankCatalogOption | null {
  if (typeof rawInput !== "string") return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const exactId = options.find((opt) => opt.bank_id === trimmed);
  if (exactId) return exactId;

  const norm = normalizeBankLookupToken(trimmed);
  if (!norm) return null;

  for (const opt of options) {
    if (
      normalizeBankLookupToken(opt.bank_id) === norm ||
      normalizeBankLookupToken(opt.bank_code) === norm ||
      normalizeBankLookupToken(opt.short_name) === norm ||
      normalizeBankLookupToken(opt.official_name) === norm ||
      normalizeBankLookupToken(opt.display_name) === norm ||
      normalizeBankLookupToken(opt.label) === norm
    ) {
      return opt;
    }
  }

  const defMatch = VIETQR_BANK_CATALOG.find((def) =>
    (def.aliases ?? []).some((alias) => normalizeBankLookupToken(alias) === norm),
  );
  if (defMatch) {
    return (
      options.find(
        (opt) =>
          opt.bank_id === defMatch.bank_id ||
          normalizeBankLookupToken(opt.bank_code) ===
            normalizeBankLookupToken(defMatch.bank_code),
      ) ?? null
    );
  }

  return null;
}

export function formatBankReferenceDisplay(
  bankId: string | null | undefined,
  bankName: string | null | undefined,
  existingBanks: readonly BankCatalogEntryInput[] = [],
): string | null {
  const merged = mergeVietQrBankCatalog(existingBanks);
  if (typeof bankId === "string" && bankId.trim().length > 0) {
    const matched = resolveBankCatalogOption(merged, bankId);
    if (matched) {
      return matched.short_name;
    }
  }
  if (typeof bankName === "string" && bankName.trim().length > 0) {
    return bankName.trim();
  }
  if (typeof bankId === "string" && bankId.trim().length > 0) {
    return bankId.trim();
  }
  return null;
}

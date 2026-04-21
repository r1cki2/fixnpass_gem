export const NAME_REGEX = /^[가-힣\s]+$/;
export const COMPANY_REGEX = /^[가-힣a-zA-Z0-9\s().,&-]+$/;
export const MOBILE_REGEX = /^010-\d{4}-\d{4}$/;
export const OFFICE_PHONE_REGEX = /^[0-9+\-()\s]{7,20}$/;

export function normalizeDigits(v: string): string {
  return (v || "").replace(/[^0-9]/g, "");
}

export function validateKoreanName(name: string): string | null {
  if (!name.trim()) return "이름을 입력해주세요.";
  if (!NAME_REGEX.test(name.trim())) return "이름은 한글만 입력 가능합니다.";
  return null;
}

export function validateCompanyName(companyName: string): string | null {
  if (!companyName.trim()) return "상호를 입력해주세요.";
  if (!COMPANY_REGEX.test(companyName.trim())) return "상호는 한글/영문/숫자와 기본 기호만 입력 가능합니다.";
  return null;
}

export function validateMobileNumber(phone: string): string | null {
  if (!MOBILE_REGEX.test(phone)) return "휴대폰 번호는 010-0000-0000 형식으로 입력해주세요.";
  return null;
}

export function validateOfficePhoneNumber(phone: string): string | null {
  if (!phone.trim()) return null;
  if (!OFFICE_PHONE_REGEX.test(phone.trim())) return "사무실 전화번호 형식이 올바르지 않습니다.";
  return null;
}

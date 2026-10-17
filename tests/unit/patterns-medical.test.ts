import { describe, expect, it } from 'vitest';
import { detect } from '../../src/core/detector';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { standardSplit } from '../../src/core/retention';
import type { Category } from '../../src/core/types';

/** [category, value] of every detected item. */
const found = (text: string) => detect(text, BUILTIN_PATTERNS).map((it) => [it.category, it.original]);
/** The values of one category detected in `text`. */
const of = (category: Category, text: string) => detect(text, BUILTIN_PATTERNS).filter((it) => it.category === category).map((it) => it.original);

describe('病歷號 (medical record numbers)', () => {
  it.each([
    ['病歷號：1234567', '1234567'],
    ['病歷號: A12345678', 'A12345678'],
    ['病歷編號：AB123456', 'AB123456'],
    ['病歷 No. 881234', '881234'],
    ['MRN: 872341', '872341'],
    ['MRN No. 872341', '872341'],
    ['MRN-2024-00123', '2024-00123'],
    ['Chart No. 9912345', '9912345'],
    ['Chart Number: 9912345', '9912345'],
    ['Medical Record Number: 1234567890', '1234567890'],
    ['門診號：8823417', '8823417'],
    ['掛號號碼 2211006', '2211006'],
    ['批價序號：20240501', '20240501'],
  ])('finds %s', (line, value) => expect(of('病歷號', line)).toEqual([value]));

  it('takes the whole hospital convention when it follows the 病歷號 label', () => {
    expect(found('案主禚小華（病歷號 MRN-2024-00123）於上午抵達')).toContainEqual(['病歷號', 'MRN-2024-00123']);
  });

  it('does not take bare numbers for medical record numbers', () => {
    expect(of('病歷號', '案號 2024-00123 與編號 9912345 業已歸檔。')).toEqual([]);
  });

  it('does not take the medical word 個管師 for a name', () => {
    expect(of('姓名', '個管師於 2024 年 5 月 1 日電訪，個案表示狀況穩定。')).toEqual([]);
  });

  it('beats the number rules for a labelled value that also reads as a tax ID or mobile', () => {
    expect(found('病歷號：04595257')).toEqual([['病歷號', '04595257']]);
    expect(found('病歷號：0912345678')).toEqual([['病歷號', '0912345678']]);
  });

  it('stays fully hidden in the standard partial retention, like 統編', () => {
    expect(standardSplit('病歷號', 'MRN-2024-00123')).toEqual({ head: 0, tail: 0 });
  });
});

describe('醫療日期 (medical dates)', () => {
  it.each([
    ['入院日期：2024-03-14', '2024-03-14'],
    ['入院日 2024/3/14', '2024/3/14'],
    ['出院日：113年5月1日', '113年5月1日'],
    ['手術日期：March 3, 2024', 'March 3, 2024'],
    ['手術日：3 March 2024', '3 March 2024'],
    ['門診日期 2024-03-14', '2024-03-14'],
    ['回診日期：2024.05.06', '2024.05.06'],
    ['Admission Date: 2024-03-14', '2024-03-14'],
    ['Date of Discharge: March 5, 2024', 'March 5, 2024'],
  ])('finds %s', (line, value) => expect(of('醫療日期', line)).toEqual([value]));

  it('leaves unlabelled dates and non-medical report dates alone', () => {
    expect(found('會議時間 2024-03-14，報告完成於 March 3, 2024。')).toEqual([]);
    expect(of('醫療日期', '調查報告 2024-03-14 出爐')).toEqual([]);
  });

  it('keeps the year in the standard partial retention, like 生日', () => {
    expect(standardSplit('醫療日期', '2024-03-14')).toEqual({ head: 5, tail: 0 });
  });
});

describe('英文姓名 (English names)', () => {
  it.each([
    ['Patient: John Smith', 'John Smith'],
    ['Patient Name: Mary Anne Chen', 'Mary Anne Chen'],
    ['Name of Patient: John Smith', 'John Smith'],
    ['English Name: John Smith', 'John Smith'],
    ['姓名：John Smith', 'John Smith'],
    ['病患姓名：Mary Chen-Wang', 'Mary Chen-Wang'],
    ['Dr. Emily Carter', 'Dr. Emily Carter'],
    ['Mr. Smith', 'Mr. Smith'],
    ['主治醫師 Dr. Wang 說明', 'Dr. Wang'],
  ])('finds %s', (line, value) => expect(of('英文姓名', line)).toEqual([value]));

  it('does not take field headings or prose for names', () => {
    expect(of('英文姓名', 'Name: Warranty Terms and Conditions apply here today now')).toEqual([]);
    expect(of('英文姓名', 'The Quick Brown Fox jumped over the lazy dog nearby today')).toEqual([]);
    expect(of('英文姓名', 'DR. EMILY CARTER 於門診說明')).toEqual([]);
  });

  it('leaves Chinese names to the 姓名 rule', () => {
    expect(found('姓名：王小明')).toEqual([['姓名', '王小明']]);
  });

  it('stays fully hidden in the standard partial retention', () => {
    expect(standardSplit('英文姓名', 'John Smith')).toEqual({ head: 0, tail: 0 });
  });
});

describe('medical rules in a full document', () => {
  it('detects the medical fields of a discharge summary', () => {
    const items = detect(
      `出院病摘
病患姓名：John Wang（病歷號：A12345678）
入院日期：2024-03-01，出院日期：2024-03-14，住院共 13 天。
主治醫師 Dr. Emily Carter 於門診說明後續照護。
`,
      BUILTIN_PATTERNS,
    );
    expect(items.map((it) => [it.category, it.original])).toEqual([
      ['英文姓名', 'John Wang'],
      ['病歷號', 'A12345678'],
      ['醫療日期', '2024-03-01'],
      ['醫療日期', '2024-03-14'],
      ['英文姓名', 'Dr. Emily Carter'],
    ]);
  });
});

export const COMPOUND_SURNAMES = ['歐陽', '司馬', '諸葛', '上官', '張簡', '范姜', '司徒', '東方', '令狐', '南宮', '端木', '皇甫', '尉遲', '夏侯'];

/** Company name split into (first two chars)(middle)(organisation suffix); shared with the preview-style retention. */
export const COMPANY_MASK_RE = /^(.{2})(.*?)(股份有限公司|有限公司|無限公司|兩合公司|企業社|工作室|事務所|商行|診所|基金會|協會|合作社|工程行|企業行|實業社|文化事業)$/u;

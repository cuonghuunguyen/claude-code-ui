import type { Messages } from "../../i18n.ts";

export default {
  "language.label": "Ngôn ngữ",
  "language.hint": "Ngôn ngữ của ứng dụng. Hệ thống: theo trình duyệt. Lưu trong trình duyệt này.",
  "language.system": "Hệ thống",
  "common.fileName.empty": "Cần nhập tên.",
  "common.fileName.dots": "“.” và “..” không phải là tên.",
  "common.fileName.slash": "Tên không được chứa / hoặc \\.",
  "common.fileName.control": "Tên không được chứa ký tự điều khiển.",
  "common.fileName.long": "Tên quá dài.",
  "common.fileName.windowsChars": "Tên không được chứa < > : \" | ? *.",
  "common.fileName.trailingDot": "Tên không được kết thúc bằng dấu chấm hoặc dấu cách.",
  "common.fileName.reserved": "“{name}” là tên dành riêng trên Windows.",
  "common.jira.httpsRule": "URL Jira phải là địa chỉ https (http chỉ dùng cho localhost hoặc 127.0.0.1)",
} satisfies Partial<Messages>;

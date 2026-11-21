# Phần giao diện của addon {#addon-parts}

Addon giao diện tạo kiểu cho claude-ui bằng CSS. Để tìm phần tử cần tạo kiểu, hãy chọn một **phần** (part): phần tử có `data-part="<tên>"`. Tên của một phần là ổn định. Tên class và giá trị `data-testid` của ứng dụng thì không: chúng có thể đổi ở bất kỳ bản phát hành nào và làm hỏng giao diện của bạn.

```css
:root[data-theme="addon:my-addon:night"] [data-part="user-message"] {
  border-left: 3px solid var(--primary);
}
:root[data-theme="addon:my-addon:night"] [data-part="tab"][data-state="running"] {
  outline: 1px solid var(--ring);
}
```

## Quy tắc {#rules}

- Chọn `[data-part="..."]`, không bao giờ chọn `[data-testid="..."]`. `data-testid` chỉ dùng cho kiểm thử.
- Trạng thái là thuộc tính nằm trên chính phần đó. Bảng liệt kê các thuộc tính của từng phần. Thuộc tính khác không thuộc hợp đồng.
- Một phần chỉ bị gỡ sau một bản minor mà phần đó được đánh dấu **deprecated** trong bảng. Phần mới có phiên bản `since`.
- Phần đánh dấu **reserved** đã có tên nhưng ứng dụng chưa hiển thị.
- Danh sách cũng nằm trong `packages/protocol/src/addon-parts.ts` (`PARTS`, `PART_NAMES`, `PartName`, `PARTS_VERSION`).

## Cascade {#cascade}

Tệp CSS của addon (`css` trong `addon.json`) được tải trong một lớp cascade riêng, `addon.<name>`, sau các style của chính ứng dụng. Thứ tự: `theme, base, components, utilities, host, addon`.

- Quy tắc của bạn thắng quy tắc của ứng dụng mà không cần `!important` hay bộ chọn dài. Đừng thêm `!important` chỉ để thắng ứng dụng.
- Ngoại lệ, thư viện: style của CodeMirror (`.cm-*`, trình soạn tệp), terminal (`.xterm*`), KaTeX (`.katex*`) và bộ tô màu mã không nằm trong lớp nào, nên thắng quy tắc của bạn bất kể bộ chọn. Hãy thêm `!important` để ghi đè.
- Ngoại lệ: khai báo có `!important` trong giao diện Neon tích hợp thắng quy tắc của bạn, và chỉ khi Neon đang được chọn.
- Thuộc tính `style` nội tuyến của phần tử vẫn thắng lớp. Hãy thêm `!important` trong quy tắc của bạn để ghi đè.
- Lớp riêng trong tệp của bạn vẫn dùng bình thường, ví dụ `@layer base, effects;`; chúng nằm trong `addon.<name>`.

## Các phần {#parts}

| Phần | Phần tử | Thuộc tính trạng thái | Từ |
|---|---|---|---|
| `titlebar` | Thanh trên cùng có dải tab | | 1.5 |
| `sidebar` | Cột danh sách phiên | | 1.5 |
| `session-item` | Một nút phiên trong thanh bên | `data-state`: `running`, `needs_input`, `idle`, `error`, `closed` | 1.5 |
| `session-search` | Ô tìm kiếm của danh sách phiên | | 1.5 |
| `group-toggle` | Tiêu đề nhóm dự án trong danh sách phiên | | 1.5 |
| `day-header` | Tiêu đề ngày trong danh sách phiên | | 1.5 |
| `work-area` | Cột chứa vùng phiên và bảng dưới | | 1.5 |
| `session-area` | Phiên đang mở: tiêu đề, dòng thời gian, ô nhập | | 1.5 |
| `session-header` | Tiêu đề của phiên đang mở | | 1.5 |
| `tab` | Một tab trong dải tab | `data-state`: `new`, `running`, `needs_input`, `unread`, `idle`; `data-active` trên tab đang mở | 1.5 |
| `focus-tab` | Tab Focus | | 1.5 |
| `terminal-tab` | Một tab terminal | | 1.5 |
| `side-panel` | Bảng cạnh cuộc trò chuyện (tệp, thay đổi, đồ thị) | | 1.5 |
| `files-panel` | Pane tệp | | 1.5 |
| `file-tree` | Cây tệp trong pane tệp | | 1.5 |
| `graph-panel` | Pane đồ thị git | | 1.5 |
| `terminal` | Bảng terminal | | 1.5 |
| `user-message` | Tin nhắn bạn gửi | | 1.5 |
| `assistant-text` | Câu trả lời dạng văn bản của Claude | | 1.5 |
| `thinking` | Dòng đang suy nghĩ | | 1.5 |
| `tool-card` | Một lần gọi công cụ | `data-status`: `pending`, `running`, `done`, `error`, `denied`, `stopped` | 1.5 |
| `permission-panel` | Câu hỏi quyền phía trên ô nhập | | 1.5 |
| `question-panel` | Câu hỏi của Claude phía trên ô nhập | | 1.5 |
| `plan-window` | Một dòng cửa sổ mức dùng của đồng hồ gói | `data-level`: `ok`, `warning`, `limit` | 1.5 |
| `prompt-box` | Ô nhập | | 1.5 |
| `prompt-toolbar` | Hàng công cụ của ô nhập | | 1.5 |
| `markdown-toolbar` | Thanh định dạng markdown | | 1.5 |
| `send` | Nút gửi (không phải nút dừng) | `data-state`: `idle`, `running`, `needs_input`, `disconnected` | 1.5 |
| `context-meter` | Đồng hồ mức dùng ngữ cảnh | | 1.5 |
| `context-bar` | Thanh trong cửa sổ mức dùng ngữ cảnh | | 1.5 |
| `status-bar` | Dòng trạng thái dưới ô nhập | | 1.5 |
| `focus-page` | Trang Focus | | 1.5 |
| `focus-row` | Một dòng của danh sách Focus | | 1.5 |
| `focus-queue` | Cột hàng đợi của trang Focus | | 1.5 |
| `toast-region` | Vùng chứa các thông báo nổi | | 1.5 |
| `scroll-to-bottom` | Nút nhảy tới tin nhắn mới nhất | | 1.5 |
| `palette` | Bảng lệnh | | 1.5 |
| `commit-message` | Ô nội dung commit | | 1.5 |
| `changed-file` | Một dòng tệp trong danh sách thay đổi | | 1.5 |
| `file-diff` | Diff của một tệp | | 1.5 |
| `loader` | Reserved: dấu đang tải của một lượt chạy | | 1.5 |
| `done-icon` | Reserved: dấu hoàn tất của lần gọi công cụ | | 1.5 |
| `backdrop` | Reserved: lớp nền toàn cửa sổ | | 1.5 |

## Kiểm tra {#checks}

Hộp thoại Addons liệt kê **Kiểm tra** dưới mỗi addon: cảnh báo từ bộ lint addon. Cảnh báo không bao giờ chặn việc cài hay bật. Mỗi cảnh báo ghi rõ tệp và dòng.

| Kiểm tra | Ý nghĩa | Cách sửa |
|---|---|---|
| `selects-testid` | Một bộ chọn dùng `[data-testid]`. Đó là mốc kiểm thử và đổi mà không báo trước. | Chọn `[data-part="..."]`. |
| `unknown-part` | `[data-part="x"]` nêu một part không có trong bảng. Nó không khớp phần tử nào. | Sửa tên (xem bảng). |
| `unprefixed-name` | Tên `@keyframes`, họ phông của `@font-face` hoặc `@property` không có tiền tố addon. Các tên này là toàn cục và có thể thay tên của ứng dụng. | Đặt tên `<addon>-name` (`--<addon>-name` cho `@property`). |
| `top-level-css` | `css` trong `addon.json` áp dụng cho mọi giao diện, mà addon có giao diện riêng. | Chuyển vào `themes[].css`. |
| `css-broken` | CSS có chú thích hoặc `url(` chưa đóng. Nó không bị giới hạn trong giao diện của nó. | Đóng lại. |
| `css-too-large` | Tệp lớn hơn 512 KB. Nó không bị giới hạn trong giao diện của nó. | Chia nhỏ hoặc rút gọn. |

Bộ chọn dùng `^=`, `$=`, `*=` hoặc `|=` trên `data-part` không được kiểm tra.

## Nhật ký thay đổi {#changelog}

- Phiên bản phần 1: các phần ở trên.

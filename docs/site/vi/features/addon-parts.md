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

## Trình duyệt hỗ trợ {#browser}

CSS của giao diện (`themes[].css`) cần CSS nesting: Chrome 120, Safari 17.2 (iOS 17.2) hoặc Firefox 117 trở lên. Bảng màu và `vars` của giao diện vẫn chạy trên trình duyệt cũ hơn, nhưng các quy tắc trong tệp CSS bị bỏ ở đó, nên giao diện chỉ hiện màu.

## Cascade {#cascade}

Tệp CSS của addon (`css` trong `addon.json`) được tải trong một lớp cascade riêng, `addon.<name>`, sau các style của chính ứng dụng. Thứ tự: `theme, base, components, utilities, host, addon`.

- Quy tắc của bạn thắng quy tắc của ứng dụng mà không cần `!important` hay bộ chọn dài. Đừng thêm `!important` chỉ để thắng ứng dụng.
- Ngoại lệ, thư viện: style của CodeMirror (`.cm-*`, trình soạn tệp), terminal (`.xterm*`), KaTeX (`.katex*`) và bộ tô màu mã không nằm trong lớp nào, nên thắng quy tắc của bạn bất kể bộ chọn. Hãy thêm `!important` để ghi đè.
- Ngoại lệ: khai báo có `!important` trong giao diện Neon tích hợp thắng quy tắc của bạn, và chỉ khi Neon đang được chọn.
- Thuộc tính `style` nội tuyến của phần tử vẫn thắng lớp. Hãy thêm `!important` trong quy tắc của bạn để ghi đè.
- Lớp riêng trong tệp của bạn vẫn dùng bình thường, ví dụ `@layer base, effects;`; chúng nằm trong `addon.<name>`.

## Vòng đời {#lifecycle}

Các thuộc tính cho biết phiên đang mở đang làm gì, để giao diện phản ứng theo. Ứng dụng đặt chúng từ trạng thái phiên, cho mọi engine (Claude Code và OpenCode).

| Thuộc tính | Trên | Giá trị |
|---|---|---|
| `data-phase` | `session-area` và `<html>`, theo phiên đang mở | `thinking` (một lượt đang chạy, kể cả OpenCode thử lại), `waiting` (cần bạn duyệt quyền hoặc trả lời câu hỏi), `idle`. Trang Focus và tab mới: `idle`. |
| `data-just-finished` | `session-area` | Có trong 1200 ms sau khi phiên đang mở chuyển từ `thinking` sang `idle`. Mất khi lượt mới bắt đầu. Không đặt sau `waiting`, và không đặt khi bạn chuyển sang phiên khác. |
| `data-focus-opened` | `focus-page` | Có trong 1200 ms sau khi trang Focus mở. |
| `data-motion` | `<html>` | `on` hoặc `off`. `off` khi hệ thống yêu cầu giảm chuyển động (cập nhật trực tiếp). |
| `data-page-hidden` | `<html>` | Có khi tab trình duyệt bị ẩn. Lúc đó ứng dụng tạm dừng mọi CSS animation, kể cả của bạn (`animation-play-state: paused !important` trong lớp `host`, thắng `!important` của bạn). |

```css
[data-part="session-area"][data-just-finished] { animation: flash 1.2s ease-out; }
:root[data-motion="off"] * { animation: none !important; }
```

Thời gian giữ 1200 ms là chủ ý: animation CSS dừng khi bộ chọn của nó không còn khớp, nên một khung hình là quá ngắn.

Ngân sách hiệu năng cho animation:

- Chỉ animate `transform` và `opacity`. Không animate `filter`, `box-shadow`, `backdrop-filter` trên bề mặt lớn.
- Ít animation vô hạn (tối đa 3 cái cùng lúc). Ưu tiên một animation cho cả trang hơn là một cái cho mỗi hàng.
- Tôn trọng `data-motion="off"`: giao diện có chuyển động cần một bản tĩnh.

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
| `session-area` | Phiên đang mở: tiêu đề, dòng thời gian, ô nhập | `data-phase`: `thinking`, `waiting`, `idle`; `data-just-finished` (xem [Vòng đời](#lifecycle)) | 1.5 |
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
| `focus-page` | Trang Focus | `data-focus-opened` (xem [Vòng đời](#lifecycle)) | 1.5 |
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

Hộp thoại Addons liệt kê **Kiểm tra** dưới mỗi addon: cảnh báo từ bộ lint addon. Cảnh báo không bao giờ chặn việc cài hay bật. Mỗi cảnh báo ghi rõ tệp và, nếu có, dòng.

| Kiểm tra | Ý nghĩa | Cách sửa |
|---|---|---|
| `selects-testid` | Một bộ chọn dùng `[data-testid]`. Đó là mốc kiểm thử và đổi mà không báo trước. | Chọn `[data-part="..."]`. |
| `unknown-part` | `[data-part="x"]` nêu một part không có trong bảng, hoặc `^=`, `$=`, `*=`, `|=` có giá trị mà không tên part nào khớp. Nó không khớp phần tử nào. Tên gần đúng được gợi ý ("Ý bạn là"). | Sửa tên (xem bảng). |
| `deprecated-part` | Bộ chọn dùng một part sắp bị bỏ. | Chuyển sang part thay thế trước bản được nêu. |
| `unprefixed-name` | Tên `@keyframes`, họ phông của `@font-face` hoặc `@property` không có tiền tố addon. Các tên này là toàn cục và có thể thay tên của ứng dụng. Daemon tự đổi tên `@keyframes`, `@counter-style` và `@font-palette-values` trong `themes[].css` (`css` cấp cao nhất không được đổi tên); `@font-face` và `@property` vẫn toàn cục. | Đặt tên `<addon>-name` (`--<addon>-name` cho `@property`). |
| `top-level-css` | `css` trong `addon.json` áp dụng cho mọi giao diện, mà addon có giao diện riêng. | Chuyển vào `themes[].css`. |
| `css-broken` | CSS không phân tích được: khối, chú thích hoặc `url(` chưa đóng, thừa `}`, hoặc nhóm lồng quá 32 cấp. CSS của giao diện khi đó được phục vụ rỗng: giao diện giữ bảng màu và mất các quy tắc. | Sửa lại. |
| `css-too-large` | Tệp lớn hơn 512 KB. CSS của giao diện khi đó được phục vụ rỗng: giao diện giữ bảng màu và mất các quy tắc. | Chia nhỏ hoặc rút gọn. |
| `css-large` | Tệp lớn hơn 256 KB (giới hạn là 512 KB). | Rút gọn trước khi chạm giới hạn. |
| `low-contrast` | Một màu chữ của bảng màu có độ tương phản dưới 4.5:1 so với nền: `fg` và `muted` trên `bg`, `fg` trên `card`, `pfg` trên `primary`, `err`, `ok` và `warn` trên `bg`. Mục này nêu cặp màu, tỉ lệ và chế độ. `border` không được kiểm tra. | Đổi màu. |

Tên `@keyframes`, `@counter-style` và `@font-palette-values` trong `themes[].css` được ứng dụng tự đổi tên, nên không bị kiểm tra ở đó (trong `css` cấp cao nhất thì có).

## Nhật ký thay đổi {#changelog}

- Phiên bản phần 1: các phần ở trên.
- Thuộc tính vòng đời `data-phase`, `data-just-finished`, `data-focus-opened`, `data-motion`, `data-page-hidden` (không đổi danh sách phần).

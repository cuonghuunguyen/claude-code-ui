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
- Danh sách cũng nằm trong `packages/protocol/src/addon-parts.ts` (`PARTS`, `PARTS_VERSION`).

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

## Nhật ký thay đổi {#changelog}

- Phiên bản phần 1: các phần ở trên.

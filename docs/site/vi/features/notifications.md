# Thông báo {#notifications}

claude-code-ui báo cho bạn khi một phiên cần nhập liệu hoặc đã xong. Có ba loại.

| Loại | Hiển thị ở đâu | Cần |
| --- | --- | --- |
| **Trong ứng dụng** | Một thẻ ở góc trang đang mở | Không cần gì. Bật mặc định. |
| **Push** | Điện thoại hoặc máy tính của bạn, kể cả khi đã đóng trang | HTTPS (hoặc `localhost`) |
| **Máy tính** | Thông báo hệ thống trên máy của daemon | Không cần gì. Được dùng khi không có trình duyệt nào bật push. |

## Cách bật push {#how-to-turn-on-push}

1. Mở ứng dụng qua HTTPS, ví dụ với [`--tailscale`](remote-access), hoặc trên `localhost`.
2. Trên iPhone hoặc iPad (iOS 16.4+): trước tiên thêm ứng dụng vào Màn hình chính và mở từ đó.
3. Mở **Cài đặt › Thông báo** và bật **Thông báo đẩy**.
4. Cho phép thông báo khi trình duyệt hỏi.

## Thẻ trong ứng dụng {#in-app-cards}

- Một thẻ hiện khi phiên bạn không đang xem cần nhập liệu, đã xong hoặc bị lỗi.
- Với yêu cầu đọc đơn giản, trả lời ngay trên thẻ: **Cho phép một lần** hoặc **Từ chối**.
- Với mọi việc khác: bấm **Mở trong Focus** để trả lời trên [trang Focus](focus).
- <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> chuyển tiêu điểm bàn phím đến thẻ mới nhất.

## Cần biết {#good-to-know}

- Push không được gửi khi trang này đang ở phía trước và hiển thị thẻ trong ứng dụng.
- Bấm vào thông báo push sẽ mở phiên đó.
- Tin nhắn push được mã hóa đầu cuối. Chúng đi qua dịch vụ push của nhà cung cấp trình duyệt (Google, Apple, Mozilla), nơi không đọc được chúng.
- Thông báo máy tính dùng `notify-send` trên Linux (gói `libnotify-bin`), trung tâm thông báo trên macOS, và toast trên Windows. Tắt chúng trong Cài đặt, hoặc khởi động với `--no-os-notify`.
- Tất cả những mục này theo từng trình duyệt, trừ công tắc thông báo máy tính, áp dụng cho toàn bộ daemon.

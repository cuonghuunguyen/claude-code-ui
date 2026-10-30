---
description: Cách khắc phục các sự cố thường gặp của claude-code-ui (lỗi cài node-pty, ghép nối, cổng, side WSL và Docker, thông báo đẩy, cập nhật) và câu trả lời cho các câu hỏi thường gặp.
---

# Xử lý sự cố và hỏi đáp

## Có gì đó không ổn {#something-is-wrong}

### `npm i` lỗi ở `node-pty` (Linux, WSL) {#npm-i-fails-on-node-pty-linux-wsl}

Bảng terminal cần bộ công cụ C++. Trên Debian hoặc Ubuntu:

```sh
sudo apt install build-essential python3
```

### Trình duyệt liên tục yêu cầu ghép nối {#the-browser-keeps-asking-to-pair}

Mở liên kết ghép nối mà daemon đã in khi khởi động (kết thúc bằng `#token=…`). Với ứng dụng trên Màn hình chính iPhone, dán liên kết đó vào **Liên kết hoặc token ghép nối** và nhấn **Ghép nối**. iOS có thể xóa dữ liệu lưu của ứng dụng sau nhiều tuần không dùng; khi đó hãy ghép nối lại.

### “Daemon này không chấp nhận token đó” {#this-daemon-does-not-accept-that-token}

Token đã đổi (tệp `token` bị xóa, hoặc bạn dùng thư mục cấu hình khác). Hãy sao chép liên kết mà daemon in gần nhất.

### Cổng đang được dùng {#port-in-use}

Khởi động trên cổng khác: `claude-ui --port 4281`.

### Side WSL hoặc Docker "stopped (exit code 1)" {#wsl-or-docker-side-stopped-exit-code-1}

Ở bản 0.5.0, mọi side WSL và Docker dừng khoảng 15 giây sau khi khởi động. Đây là lỗi đã biết: [#263](https://github.com/cuonghuunguyen/claude-code-ui/issues/263). **Thử lại** khởi động lại side nhưng nó lại dừng. Windows và các dự án cục bộ không bị ảnh hưởng.

### Side cần Node.js hoặc công cụ build {#the-side-needs-nodejs-or-build-tools}

Hộp thoại Mở dự án cho biết thiếu gì. Một bản phân phối WSL hoặc container Docker dùng glibc (Debian, Ubuntu, ...) chỉ cần `sh`, `tar` và `gzip` (bản phân phối WSL cần thêm `bash`): claude-code-ui dùng Node.js 22+ tìm thấy ở đó, nếu không thì tự mang theo bản riêng. Bản phân phối WSL cài bằng npm (musl, xem bên dưới) cần Node.js 22+, make, python3 và g++. Mở **Container này cần gì** trong hộp thoại để xem danh sách với dấu ✓ hoặc ✗ cho từng mục. Hộp thoại không kiểm tra đăng nhập Claude: phiên bắt đầu mà chưa đăng nhập sẽ báo như vậy. Xem [WSL và Docker](../features/wsl-docker).

### Container Docker hoặc bản phân phối WSL cài bằng npm, không dùng bundle {#a-docker-container-or-wsl-distro-installs-with-npm-not-the-bundle}

Hộp thoại nói lý do. Các nguyên nhân:

- Container hoặc bản phân phối dùng musl (Alpine) hoặc CPU khác x86_64 và arm64, có glibc cũ hơn 2.28, hoặc không có libstdc++. Hãy dùng image hoặc bản phân phối glibc, hoặc cài Node.js 22+, make, python3 và g++ ở đó.
- Máy tính của bạn không tải được một thành phần (Node.js từ nodejs.org, chỉ cho đích không có Node.js 22+; node-pty, Claude Agent SDK hoặc Claude Code từ registry npm) và không có bản đã kiểm tra trong `~/.cache/claude-ui/side`. Kiểm tra mạng hoặc đặt `CLAUDE_UI_UPDATE_REGISTRY` thành một bản sao registry, rồi thử lại.

- `docker exec` không chạy được trong container (đã dừng giữa chừng, không có `sh`, lỗi runtime): lý do trích dẫn lỗi đó.

Các thành phần của phiên bản claude-ui cũ hơn ở lại trong bộ nhớ đệm 7 ngày sau lần dùng cuối, rồi bị xóa.

Thành phần đã tải hoặc đã lưu đệm mà không khớp checksum sẽ không bao giờ được dùng: nó được tải lại.

### Thông báo đẩy không hoạt động {#push-notifications-do-not-work}

- Trang phải dùng HTTPS (hoặc `localhost`). Dùng [`--tailscale`](../features/remote-access).
- Trên iPhone/iPad: iOS 16.4+, và ứng dụng phải nằm trên Màn hình chính.
- Không có HTTPS, máy tính của daemon sẽ hiện thông báo màn hình nền thay thế (Linux cần `notify-send`, gói `libnotify-bin`).

### Phiên bản mới không khởi động {#a-new-version-does-not-start}

claude-code-ui quay về phiên bản trước và thông báo điều đó. Xem [Cập nhật](../features/updates).

### `--tailscale` thoát ngay lập tức {#tailscale-exits-right-away}

Nó in ra thứ còn thiếu: Tailscale chưa cài hoặc chưa đăng nhập, MagicDNS hoặc chứng chỉ HTTPS đang tắt, máy chưa được duyệt, hoặc Funnel đang bật. Trên Linux không có quyền root, chạy `sudo tailscale set --operator=$USER` một lần. Trên Windows có WSL, chạy `--tailscale` trên Windows, không phải trong WSL.

## Hỏi đáp {#faq}

### Phiên có dừng khi tôi đóng trình duyệt không? {#do-sessions-stop-when-i-close-the-browser}

Không. Chúng chạy trong daemon. Mở lại trang để xem tiếp.

### Phiên có dừng khi tôi dừng daemon không? {#do-sessions-stop-when-i-stop-the-daemon}

Lượt đang chạy sẽ dừng. Phiên và lịch sử vẫn còn, và bạn có thể tiếp tục sau lần khởi động tiếp theo.

### Nó có dùng được với các phiên từ CLI `claude` không? {#does-it-work-with-sessions-from-the-claude-cli}

Có. Cả hai đọc và ghi cùng một lịch sử trong `~/.claude`. Phiên bắt đầu ở bên này sẽ hiện ở bên kia.

### Làm sao hủy ghép nối mọi trình duyệt? {#how-do-i-unpair-all-browsers}

Xóa tệp `token` trong [thư mục cấu hình](cli#files) và khởi động lại. Mọi trình duyệt phải ghép nối lại.

# Cài đặt và chạy lần đầu

claude-code-ui chạy một máy chủ cục bộ nhỏ (**daemon**) trên máy tính của bạn. Bạn mở trang web của nó trong trình duyệt.

## Bạn cần gì {#what-you-need}

- **Node.js 22** trở lên.
- **Claude Code đã đăng nhập.** Chạy `claude login` một lần. claude-code-ui dùng gói đăng ký Claude của bạn. Nó không dùng khóa API.
- **Chỉ Linux và WSL:** cần bộ công cụ C++ để bảng terminal biên dịch được. Trên Debian hoặc Ubuntu: `sudo apt install build-essential python3`. Windows và macOS không cần thêm gì.

## Cách khởi động {#how-to-start}

1. Chạy mà không cần cài đặt:
   ```sh
   npx claude-code-ui
   ```
   Hoặc cài đặt một lần. Khi đó lệnh là `claude-ui`:
   ```sh
   npm i -g claude-code-ui
   claude-ui
   ```
2. Terminal in ra một **liên kết ghép nối** (`http://127.0.0.1:4280/#token=…`) và mã QR.
3. Mở liên kết trong trình duyệt. Token trong liên kết ghép nối trình duyệt này với daemon.
4. Nhấn **Mở dự án** và chọn một thư mục.
5. Nhập prompt và nhấn <kbd>Enter</kbd>.

Lần đầu, một **Tham quan có hướng dẫn** ngắn sẽ giới thiệu giao diện. Bạn có thể bỏ qua, hoặc chạy lại sau trong **Cài đặt › Trợ giúp & giới thiệu**.

## Cần biết {#good-to-know}

- Giữ terminal mở. Đóng terminal sẽ dừng daemon. Các phiên của bạn vẫn được lưu và quay lại ở lần khởi động sau.
- Các phiên vẫn chạy khi bạn đóng tab trình duyệt.
- Mặc định daemon chỉ lắng nghe trên `127.0.0.1` (máy tính này). Để dùng từ điện thoại, xem [Điện thoại và truy cập từ xa](../features/remote-access).
- Phiên chỉ dùng được các thư mục nằm trong thư mục home của bạn. Đổi bằng [`--roots`](../reference/cli).
- Các phiên bạn bắt đầu trong CLI `claude` hoặc tiện ích mở rộng VS Code cũng hiện ở đây, và ngược lại.
- Mất liên kết ghép nối? Liên kết được in lại ở mỗi lần khởi động.
- Có gì hỏng? Xem [Xử lý sự cố](../reference/troubleshooting).

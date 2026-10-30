# Terminal {#terminal}

Một terminal thật trong thư mục của phiên, mặc định gắn ở cuối cửa sổ. Terminal cũng có thể nằm trong bảng bên hoặc là một tab ở vùng chính. Terminal chạy trên máy của daemon.

![Hai terminal trong bảng dưới, terminal thứ hai hiển thị kết quả kiểm thử](/screenshots/terminal.png)

## Cách dùng {#how-to-use}

1. Nhấn <kbd>Ctrl</kbd>+<kbd>`</kbd> để hiện hoặc ẩn terminal (hoặc nút terminal trong bảng bên).
2. Nhập lệnh như trong mọi terminal.
3. Bấm **+** (**Terminal mới**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd>) để mở thêm một terminal. Mỗi terminal có một tab ở hàng phía trên: Terminal 1, Terminal 2…

## Shell nào {#which-shell}

| Hệ thống | Shell |
| --- | --- |
| Linux, macOS | `$SHELL`, nếu không có thì `bash` |
| Windows | `SHELL` nếu nó trỏ tới một tệp Windows, nếu không thì `pwsh`, rồi Windows PowerShell, rồi `cmd.exe` |
| Phiên WSL hoặc Docker | Shell của phía đó |

Với Git Bash trên Windows, đặt `SHELL` thành `C:\Program Files\Git\bin\bash.exe` trước khi khởi động claude-ui.

## Cần biết {#good-to-know}

- Terminal là một [khung](panes): nó nằm trong bảng dưới, bên dưới phiên và bảng bên. Bảng dưới có thể đổi kích thước và phóng to tối đa. **Vị trí terminal** trong [Cài đặt › Bố cục › Terminal](../reference/settings#terminal), hoặc việc di chuyển tab của nó, đặt terminal vào bảng bên hoặc vùng chính.
- Ở vùng chính, các terminal của một dự án gộp thành một tab ("Terminal · *dự án*") vẫn tồn tại khi bạn làm việc trong dự án khác. Sau khi tải lại, mỗi thư mục hiển thị terminal bạn đã chọn trong đó.

- Terminal sống trong daemon. Chúng vẫn còn sau khi tải lại trang hoặc mất kết nối, và kết quả gần nhất được phát lại.
- Shell chỉ khởi động khi bạn mở terminal (Bật/tắt terminal, Terminal mới, hoặc bấm vào tab của nó), không bao giờ khi tải lại, chuyển phiên hay dự án, hoặc kết nối lại. Terminal bạn để mở chỉ hiện lại khi thư mục của nó có shell đang chạy, và khi đó nó không lấy tiêu điểm.
- Các phím <kbd>Ctrl</kbd>+chữ thông thường được chuyển cho shell. Phím tắt của ứng dụng với <kbd>Alt</kbd> vẫn hoạt động.
- Tối đa 8 terminal mỗi tab trình duyệt, tổng cộng 32.
- Biểu tượng Nerd Font (nhiều prompt shell dùng) hiển thị đúng.
- Trên Linux và WSL, terminal cần bộ công cụ C++ khi cài đặt. Xem [Cài đặt](../guide/install).

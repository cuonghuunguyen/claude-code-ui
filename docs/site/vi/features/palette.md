# Bảng lệnh {#command-palette}

Một ô tìm kiếm cho lệnh, phiên, tệp và nội dung tin nhắn.

![Bảng lệnh](/screenshots/palette.png)

## Cách dùng {#how-to-use}

1. Nhấn <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd> <kbd>K</kbd> trên Mac), hoặc <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, hoặc bấm biểu tượng tìm kiếm ở góc trên bên phải.
2. Nhập vài chữ cái.
3. Chọn một hàng bằng phím mũi tên và nhấn <kbd>Enter</kbd>.

## Tìm được gì {#what-it-finds}

| Nhóm | Ví dụ |
| --- | --- |
| **Lệnh** | Phiên mới, Worktree mới…, Bật/tắt terminal, Hiện đồ thị git, Bật/tắt chỉ tín hiệu, Mở cài đặt, Hiện hướng dẫn, Mở Focus, Dừng, Đổi model, Đổi mức suy nghĩ, Đổi chế độ quyền, Tua lại, Đổi tài khoản Claude…, Mở trong trình quản lý tệp, Thêm tệp vào prompt, Thêm phần chọn vào chat |
| **Git** | Git: Commit, Git: Push, Git: Rollback…, Git: Nhánh mới…, Git: Checkout…, Git: Smart checkout…, Git: Stash…, Git: Chú thích (Blame), Git: Merge…, Git: Rebase… |
| **Tùy chỉnh** | Máy chủ MCP, Lệnh slash, Quản lý plugin |
| **Phiên** | Các phiên của bạn, mới nhất trước |
| **Tệp** | Các tệp của dự án hiện tại |
| **Tin nhắn** | Văn bản bên trong các phiên của bạn, mới nhất trước |

## Cần biết {#good-to-know}

- Chỉ các lệnh phù hợp ở thời điểm hiện tại mới được liệt kê. Ví dụ, Tua lại bị ẩn khi Claude đang làm việc.
- Các lệnh git hiện trong kho git. Rollback, Checkout, Merge và Rebase mở hộp thoại tương ứng hoặc danh sách nhánh trong Đồ thị git, để bạn chọn nhánh ở đó. **Thêm phần chọn vào chat** hiện khi có dòng diff được chọn trong Thay đổi, và **Đổi tài khoản Claude…** hiện khi có từ hai tài khoản.
- Các lệnh Rollback, Nhánh mới, Checkout, Smart checkout, Stash, Chú thích, Merge, Rebase, Mở trong trình quản lý tệp, Thêm vào prompt, Thêm phần chọn vào chat và Đổi tài khoản không có phím tắt mặc định. Gán phím trong **Phím tắt**.
- Mỗi lệnh hiển thị phím tắt của nó. Tất cả có trên trang [Phím tắt](../reference/shortcuts).
- Để mở trực tiếp một tệp, <kbd>Ctrl</kbd>+<kbd>P</kbd> (**Mở tệp**) nhanh hơn.

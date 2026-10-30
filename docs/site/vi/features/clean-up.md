# Dọn dẹp {#clean-up}

Đóng hoặc gỡ nhiều tab, worktree và worker cùng lúc, có kiểm tra an toàn cho từng mục.

![Hộp thoại Dọn dẹp](/screenshots/clean-up.png)

## Dọn dẹp worktree và worker {#clean-up-worktrees-and-workers}

1. Mở [bảng lệnh](palette) và chạy **Dọn dẹp worktree và worker…**. Hoặc mở menu của một dự án và chọn **Dọn dẹp…**, hoặc menu của một coordinator và chọn **Dọn dẹp worker…** (xem [Menu ngữ cảnh](context-menus)).
2. Đọc nhãn của từng hàng: **An toàn**, **Có công việc** (tệp chưa commit hoặc commit chưa push, kèm số lượng) hoặc **Bị chặn** (kèm lý do).
3. Đánh dấu các hàng cần gỡ. Worktree an toàn và worker đã đóng được đánh dấu sẵn. Dùng **Cũ hơn** và **Chỉ an toàn** để thu hẹp danh sách.
4. Bấm **Gỡ N**. Bản tóm tắt liệt kê những gì đã gỡ và những gì bị bỏ qua, cùng lý do.

## Dọn dẹp tab {#clean-up-tabs}

1. Mở menu tab và chọn **Dọn dẹp tab…**, hoặc chạy từ bảng lệnh.
2. Chọn một quy tắc: tab nhàn rỗi, tab đã xong, tab của phiên đã lưu trữ hoặc đã xóa, tab worker, hoặc tab không dùng trong 1 giờ, 1 ngày hoặc 7 ngày. Mỗi quy tắc hiển thị số tab nó đóng.
3. Thông báo **Đã đóng N tab** xuất hiện. Bấm **Hoàn tác** để đưa chúng trở lại.

Để đóng các tab nhàn rỗi của một nhóm, nhấp chuột phải vào nhãn nhóm và chọn **Dọn dẹp nhóm** (xem [Menu ngữ cảnh](context-menus#group-chips)). Trên điện thoại, nhấn giữ nút đóng.

## Cần biết {#good-to-know}

- Tab đang hoạt động, đã ghim, đang chạy, chưa đọc, và tab có bản nháp chưa gửi luôn được giữ lại. Đóng tab không dừng phiên của nó.
- Gỡ một worktree có công việc cần thêm một ô đánh dấu: **Bỏ các tệp chưa commit và commit chưa push**. Nhánh đã merge có thể được xóa cùng (**Xóa luôn nhánh**, mặc định tắt).
- Việc quét nhanh và không làm chậm thanh trạng thái. Nhánh đã squash-merge được tính là đã merge, nên worktree của nó là **An toàn**. Trạng thái của worktree được lưu đệm để hiển thị; khi gỡ luôn kiểm tra lại.
- Việc gỡ worktree chạy nền: mọi hàng trong hàng đợi hiển thị **Đang gỡ…**.
- Mọi worktree liên kết nằm trong các thư mục gốc của bạn đều gỡ được, kể cả worktree tạo thủ công hoặc bằng công cụ khác. Worktree bị khóa hoặc là symlink thì **Bị chặn**.
- Worktree gắn nhãn **Bên ngoài** không nằm trong `.claude/worktrees` và không được đánh dấu sẵn.

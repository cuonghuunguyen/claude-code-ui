# Menu ngữ cảnh {#context-menus}

Nhấp chuột phải (hoặc nhấn giữ, hoặc <kbd>Shift</kbd>+<kbd>F10</kbd> trên hàng đang được chọn) vào một dự án, worktree, worker, phiên hoặc tab để xem các thao tác của nó.

![Menu ngữ cảnh của một hàng dự án](/screenshots/context-menu.png)

## Thanh bên {#sidebar}

| Hàng | Mục |
| --- | --- |
| Dự án | Phiên mới, Worktree mới (tạo ngay, tên tự sinh), Tạo worktree…, Ẩn các phiên không hoạt động, Lưu trữ các phiên rảnh quá 1, 7 hoặc 30 ngày, Dọn dẹp…, Gỡ khỏi danh sách (tệp vẫn còn) |
| Worktree | Phiên mới, Ẩn các phiên không hoạt động, các mục lưu trữ tương tự, Xóa worktree… |
| Phiên | Đổi tên, Lưu trữ, Sao chép ID phiên, Đóng tab, Xóa… |
| Worker | Đóng worker, Gỡ worker… (có tùy chọn gỡ luôn worktree của nó) |
| Coordinator, hoặc hàng "N worker" của nó | Đóng các worker đã xong, Gỡ các worker đã đóng…, Dọn dẹp worker… |

Trên màn hình hẹp, nút **⋯** của hàng dự án hoặc worktree liệt kê các mục tương tự.

## Tab {#tabs}

Nhấp chuột phải vào một tab phiên:

- **Đóng tab**, **Đóng các tab khác**, **Đóng các tab bên phải** và **Đóng tất cả** hiện thông báo **Đã đóng N tab** kèm **Hoàn tác**. Tab đã ghim được giữ lại.
- **Ghim tab** giữ tab ở đầu nhóm của nó, dưới dạng biểu tượng không có nút đóng.
- **Sao chép ID phiên** và **Hiện trong thanh bên**, hiển thị và chọn hàng của phiên.
- **Chia sang phải** và **Chia xuống dưới**, xem [Chia màn hình](split-view).

Các lệnh đóng và ghim cũng có trong [bảng lệnh](palette) và có thể gán phím trong [Phím tắt](../reference/shortcuts). Thêm cách đóng nhiều tab: [Dọn dẹp](clean-up).

## Nhãn nhóm {#group-chips}

Nhấp chuột phải vào nhãn nhóm (tên dự án đứng trước các tab của nó):

- **Chuyển nhóm sang trái** và **Chuyển nhóm sang phải**.
- **Dọn dẹp nhóm** đóng các tab rảnh của nhóm đó.
- **Đóng các nhóm khác** và **Đóng nhóm**.

![Menu chuột phải của một nhãn nhóm](/screenshots/group-menu.png)

Khi bật **Tab gọn** ([Cài đặt › Bố cục › Tab](../reference/settings#tabs)), di chuột hoặc bấm vào nhãn sẽ mở một menu chỉ liệt kê các tab của nhóm. Các thao tác nhóm ở trên vẫn nằm trong menu chuột phải của nhãn.

## Tệp {#files}

Cây tệp có menu riêng, xem [Tệp](files#file-tree-menu).

## Cần biết {#good-to-know}

- Lưu trữ các phiên rảnh sẽ hỏi trước và nêu số lượng. Một coordinator chỉ được lưu trữ khi nó và mọi worker của nó đều rảnh.
- **Đóng worker đã xong** không hỏi. **Gỡ worker đã đóng…** và **Gỡ worker…** thì có hỏi.

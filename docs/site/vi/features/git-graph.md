# Đồ thị Git {#git-graph}

Khung **Đồ thị** hiển thị lịch sử commit của dự án dưới dạng đồ thị, giống `git log --graph`. Khung đọc lịch sử và chạy các thao tác git từ menu của nó: **Fetch**, Push, Pull, Merge, Rebase, Checkout, nhánh mới, thao tác commit và stash. Mặc định nó nằm trong bảng bên và có thể là một tab ở vùng chính, nơi nó chiếm toàn bộ vùng (xem [Khung & bố cục](panes)).

![Đồ thị git với nhánh, tag và commit](/screenshots/git-graph.png)

## Cách dùng {#how-to-use}

1. Mở bảng bên và chọn **đồ thị** (hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
2. Trong thư mục có nhiều kho mã, chọn kho mã trước (xem [Thay đổi](changes#repositories)). Lựa chọn được dùng chung với Thay đổi.
3. Chọn nhánh cần hiển thị: **HEAD** (mặc định) hoặc **Mọi nhánh**, hoặc một nhánh.
4. Tìm kiếm bằng **Văn bản hoặc hash**, hoặc lọc theo **Tác giả**.
5. Bấm một commit để xem chi tiết và diff của từng tệp.

## Cần biết {#good-to-know}

- Nhãn được tô màu theo loại: HEAD, nhánh cục bộ, nhánh từ xa và tag.
- Mỗi lần tải 200 commit. Các commit cũ hơn tải khi bạn cuộn xuống.
- **Làm mới** tải lại đồ thị.
- **Fetch** và menu nhánh tác động lên kho mã đang chọn. Fetch một submodule chỉ fetch các remote riêng của nó.
- Commit đã di chuyển một submodule hiển thị "Submodule *đường dẫn* → *commit*" thay cho diff, kèm **Xem đồ thị của** *đường dẫn*.

## Menu nhánh {#branch-menu}

Bấm **›** trên một nhánh trong popup nhánh, hoặc bấm chuột phải một nhãn nhánh, để mở các thao tác của nhánh đó. Thao tác không bao giờ dùng được thì không có (nhánh hiện tại không có Checkout, Merge hay Rebase). Một chặn tạm thời bị vô hiệu hóa và nói lý do. Mỗi thao tác hỏi trong một hộp thoại hiển thị đúng lệnh git; Hủy thì không chạy gì.

- **Checkout**, hoặc **Checkout thành nhánh local mới** cho nhánh từ xa. Khi thay đổi local vướng, **Smart checkout** đề nghị mang chúng theo.
- **Push**, **Force push…** (màu đỏ, nêu các commit bị thay thế) và **Pull** (chỉ fast-forward).
- **Merge vào** *hiện tại*… và **Rebase** *hiện tại* **lên** *nhánh*….
- **Nhánh mới từ** *nhánh*….

Merge, rebase, nhánh mới, checkout và Smart checkout được mô tả ở [Thao tác Git](git).

## Menu commit {#commit-menu}

Bấm chuột phải một commit (nhấn giữ, <kbd>Shift</kbd>+<kbd>F10</kbd>) để có các thao tác commit:

| Mục | Làm gì |
| --- | --- |
| **Sao chép mã commit** | Sao chép hash đầy đủ. |
| **Cherry-pick** | Áp dụng commit vào nhánh hiện tại. |
| **Reset nhánh hiện tại về đây…** | Chuyển nhánh về commit này: **Soft** (giữ thay đổi ở trạng thái staged), **Mixed** (mặc định, giữ chúng chưa staged) hoặc **Hard** (bỏ thay đổi của file đã theo dõi; liệt kê các file bị ghi đè, nút xác nhận là **Reset hard**). |
| **Revert commit** | Thêm một commit hoàn tác commit này. |
| **Hoàn tác commit** | Chỉ trên commit của HEAD, và không khi nó đã được push: bỏ commit và giữ thay đổi của nó ở trạng thái staged. |
| **Nhánh mới…** | Tạo nhánh tại commit này. |

Cherry-pick, Revert và Hoàn tác chạy ngay. Nếu cherry-pick hoặc revert dừng vì xung đột, banner của [Thay đổi](git#conflicts) tiếp quản. Reset hard giữ nội dung các tệp bị thay thế trong [Lịch sử cục bộ](timeline#local-history-file-timeline).

## Stash {#stashes}

Nút bật **Stash** mở một dải với danh sách stash: **Stash thay đổi…**, và **Apply**, **Pop**, **Drop** cho mỗi mục. Xem [Thao tác Git](git#stashes).

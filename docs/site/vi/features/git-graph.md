# Biểu đồ Git {#git-graph}

Khung **Biểu đồ** hiển thị lịch sử commit của dự án dưới dạng biểu đồ, giống `git log --graph`. Khung chỉ đọc, trừ **Fetch**. Mặc định nó nằm trong bảng bên và có thể là một tab ở vùng chính, nơi nó chiếm toàn bộ vùng (xem [Khung & bố cục](panes)).

![Biểu đồ git với nhánh, tag và commit](/screenshots/git-graph.png)

## Cách dùng {#how-to-use}

1. Mở bảng bên và chọn **biểu đồ** (hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
2. Trong thư mục có nhiều kho mã, chọn kho mã trước (xem [Thay đổi](changes#repositories)). Lựa chọn được dùng chung với Thay đổi.
3. Chọn nhánh cần hiển thị: **HEAD** (mặc định) hoặc **Mọi nhánh**, hoặc một nhánh.
4. Tìm kiếm bằng **Văn bản hoặc hash**, hoặc lọc theo **Tác giả**.
5. Bấm một commit để xem chi tiết và diff của từng tệp.

## Cần biết {#good-to-know}

- Nhãn được tô màu theo loại: HEAD, nhánh cục bộ, nhánh từ xa và tag.
- Mỗi lần tải 200 commit. Các commit cũ hơn tải khi bạn cuộn xuống.
- **Làm mới** tải lại biểu đồ.
- **Fetch** và menu nhánh tác động lên kho mã đang chọn. Fetch một submodule chỉ fetch các remote riêng của nó.
- Commit đã di chuyển một submodule hiển thị "Submodule *đường dẫn* → *commit*" thay cho diff, kèm **Xem đồ thị của** *đường dẫn*.
- Nó không bao giờ checkout, commit hay push.

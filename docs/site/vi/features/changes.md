# Thay đổi & diff {#changes-diffs}

Khung **Thay đổi** hiển thị những gì đã đổi, dưới dạng diff, theo từng tệp.

![Bảng Thay đổi với một diff](/screenshots/changes.png)

## Cách dùng {#how-to-use}

1. Mở bảng bên và chọn **thay đổi** (hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>).
2. Chọn một **chế độ diff**:

   | Chế độ | Hiển thị |
   | --- | --- |
   | **Thay đổi của phiên** | Những gì Claude đã đổi trong phiên này |
   | **Chưa commit** | Các thay đổi git chưa commit của bạn |
   | **So với nhánh** | Mọi thứ khác với một nhánh bạn chọn |

3. Bấm một tệp trong danh sách, hoặc dùng <kbd>←</kbd> / <kbd>→</kbd> để chuyển đến tệp trước hoặc sau.

## Kho mã {#repositories}

Một thư mục dự án có thể chứa nhiều kho mã: kho lồng nhau, hoặc submodule. Trong các chế độ git, **bộ chọn kho mã** trên thanh công cụ hiển thị kho đang chọn (tên và nhánh). Nó mở ra một cây: kho mã của chính dự án, các submodule, rồi các kho mã lồng nhau. Chọn một kho để xem thay đổi của nó. Lựa chọn được lưu theo dự án trong trình duyệt này và dùng chung với [Đồ thị Git](git-graph).

- Thư mục dự án tự nó không phải kho mã nhưng chứa một số kho mã vẫn có các chế độ git.
- Submodule có commit khác với commit đã ghi nhận hiển thị nhãn **submodule** thay cho diff văn bản. Submodule có thay đổi chưa commit hiển thị "nội dung đã sửa (N tệp)". Thư mục kho mã nhúng hiển thị một hàng **kho mã**. **Xem thay đổi trong** *đường dẫn* trên các hàng này đổi bộ chọn.
- Những kho mã nào được tìm thấy phụ thuộc vào các thiết lập trong [Cài đặt › Git](../reference/settings#git).

## Báo cho Claude về một thay đổi {#tell-claude-about-a-change}

- **Thêm vào prompt:** bấm chuột phải một hàng (nhấn giữ, <kbd>Shift</kbd>+<kbd>F10</kbd>) và chọn **Thêm vào prompt**. Nó chèn tệp dưới dạng `@` mention. Không áp dụng cho tệp đã xóa. Mục này cũng có trong menu ở chế độ **Thay đổi của phiên**.
- **Gửi phần chọn cho Claude:** trong diff của tệp văn bản, chọn các dòng trên số dòng (bấm, <kbd>Shift</kbd>+bấm hoặc kéo), rồi bấm **Gửi phần chọn cho Claude** trên tiêu đề diff, hoặc nhấn <kbd>Alt</kbd>+<kbd>K</kbd> (<kbd>⌥</kbd> <kbd>K</kbd> trên Mac). Ô prompt nhận tên tệp, số dòng và các dòng đã chọn, dòng bị xóa đánh dấu `-` và dòng được thêm đánh dấu `+`. Bạn chỉnh rồi gửi.
- Cả hai cũng có trong [bảng lệnh](palette) (**Thêm tệp vào prompt**, **Gửi phần chọn cho Claude**), không có phím mặc định.

## Nhãn trạng thái {#status-badges}

Mỗi hàng có một nhãn chữ cái: **M** đã sửa, **A** đã thêm, **D** đã xóa, **R** đã đổi tên. Tệp mới mà git chưa theo dõi hiển thị **U** màu đỏ (chưa theo dõi) thay cho **A**. Tệp bạn đã thêm vào index bằng `git add` vẫn là **A**.

## Commit, rollback, xử lý xung đột {#commit-roll-back-resolve}

Ở chế độ **Chưa commit**, một hộp commit nằm phía trên danh sách: chọn tệp, viết hoặc tạo nội dung, **Commit** hoặc **Commit và Push**, **Sửa commit trước**, **Rollback**. Một banner hiển thị merge hoặc rebase chưa xong với **Tiếp tục**, **Hủy** và **Nhờ Claude xử lý**. Xem [Thao tác Git](git).

## Cần biết {#good-to-know}

- **Chưa commit** và **So với nhánh** cần một kho git.
- **Tệp hiển thị: Dự án / Tất cả:** chỉ thư mục của phiên, hoặc toàn bộ kho mã.
- Chuyển giữa **Diff chia đôi** và **Diff gộp**. Màn hình hẹp luôn dùng diff gộp.
- Kéo cạnh của danh sách tệp để đổi kích thước, hoặc chọn nó rồi nhấn <kbd>←</kbd> / <kbd>→</kbd>. Nhấp đúp vào cạnh để khôi phục độ rộng. Độ rộng được lưu theo trình duyệt.
- **Lọc tệp** thu hẹp danh sách theo tên.
- Thư mục chỉ có một thư mục con hiện thành một dòng (`src/components`). **Xem dạng danh sách** hiện các tệp phẳng, mỗi tệp theo đường dẫn của nó; **Xem dạng cây** quay lại. Lựa chọn được lưu theo trình duyệt.
- Chọn chế độ mà khung mở ra tại [Cài đặt › Bố cục › Thay đổi](../reference/settings#changes).
- Thanh trạng thái dưới ô nhập prompt hiển thị nhánh và số đếm `+thêm −xóa`.

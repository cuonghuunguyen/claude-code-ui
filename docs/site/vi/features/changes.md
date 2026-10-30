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

## Cần biết {#good-to-know}

- **Chưa commit** và **So với nhánh** cần một kho git.
- **Tệp hiển thị: Dự án / Tất cả:** chỉ thư mục của phiên, hoặc toàn bộ kho mã.
- Chuyển giữa **Diff chia đôi** và **Diff gộp**. Màn hình hẹp luôn dùng diff gộp.
- Kéo cạnh của danh sách tệp để đổi kích thước, hoặc chọn nó rồi nhấn <kbd>←</kbd> / <kbd>→</kbd>. Nhấp đúp vào cạnh để khôi phục độ rộng. Độ rộng được lưu theo trình duyệt.
- **Lọc tệp** thu hẹp danh sách theo tên.
- Chọn chế độ mà khung mở ra tại [Cài đặt › Bố cục › Thay đổi](../reference/settings#changes).
- Thanh trạng thái dưới ô nhập prompt hiển thị nhánh và số đếm `+thêm −xóa`.

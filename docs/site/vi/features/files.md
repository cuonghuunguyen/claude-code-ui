# Tệp

Khung **Tệp**: cây tệp và một trình soạn thảo đơn giản cho thư mục của phiên. Mặc định nó nằm ở bảng bên; nó cũng có thể là tab trong vùng chính (xem [Khung & bố cục](/vi/features/panes)).

![Cây tệp với cart.ts mở trong trình soạn thảo](/screenshots/files.png)

## Cách dùng {#how-to-use}

1. Mở bảng bên và chọn **tệp** (hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>).
2. Bấm một tệp trong cây để mở nó trong tab trình soạn thảo.
3. Sửa tệp và nhấn <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd> trên Mac) để lưu.
4. Để tìm tệp theo tên, nhấn <kbd>Ctrl</kbd>+<kbd>P</kbd> (**Mở tệp**).

## Chế độ xem tệp {#file-view}

- Cây hiện biểu tượng loại tệp và dấu trạng thái git (đã sửa, đã thêm, chưa theo dõi…) cho từng tệp. Tệp trong kho mã lồng nhau hoặc submodule nhận dấu của kho mã riêng của nó. Thư mục kho mã hiện biểu tượng kho mã và submodule hiện biểu tượng lưu trữ; cả hai đều không nhận một chữ `U` đơn lẻ từ kho mã cha. Bấm chuột phải vào một mục để chọn **Hiện thay đổi** hoặc **Hiện đồ thị**: chúng chuyển [bộ chọn kho mã](/vi/features/changes#repositories) của Thay đổi và Git graph.
- Các tab đang mở và chỉnh sửa chưa lưu được khôi phục sau khi tải lại trang.
- Một cú bấm đơn mở **tab xem trước** (tiêu đề in nghiêng); cú bấm đơn tiếp theo thay thế nó. Bấm đúp vào tab hoặc dòng trong cây, hoặc sửa tệp, để giữ nó mở.
- Đường dẫn breadcrumb và dấu chưa lưu (●) nằm phía trên trình soạn thảo. Tệp Markdown có thể hiện bản xem trước đã dựng.
- Bản xem trước Markdown hiện bảng với chiều cao đầy đủ; bản xem trước cuộn được.
- Tệp nhị phân và tệp rất lớn hiện thông báo rõ ràng thay vì mở.
- **Lọc tệp** và `@` trong hộp prompt cũng tìm tệp bên trong kho mã lồng nhau và submodule.
- Khi chưa mở tệp nào, cây chiếm toàn bộ tab. Từ chiều rộng bảng 672px, cây nằm cạnh trình soạn thảo; hẹp hơn thì nó là ngăn kéo (nút **Tệp** hoặc <kbd>Ctrl</kbd>+<kbd>\\</kbd>).

## Hộp thoại tệp {#file-dialog}

Bấm **Tách ra** trong tab Tệp để mở cây, các tab và trình soạn thảo trong một hộp thoại lớn. Đó là cùng một trạng thái: tab đang mở, chỉnh sửa chưa lưu, con trỏ và lịch sử hoàn tác được giữ nguyên, và cả khi quay lại (**Mở trong trình soạn thảo**).

Thẻ **Read** trong dòng thời gian, đường dẫn tệp trong câu trả lời của Claude (`src/cart.js:12`) và **Mở trong hộp thoại tệp** trong menu cây sẽ mở tệp tại đó, ở đúng dòng.

## Menu cây tệp {#file-tree-menu}

Bấm chuột phải (nhấn giữ, hoặc <kbd>Shift</kbd>+<kbd>F10</kbd>) vào tệp hoặc thư mục:

| Mục | Tác dụng |
| --- | --- |
| **Tệp mới…**, **Thư mục mới…** | Tạo trong thư mục đó. Các mục tương tự có trong menu của khoảng trống trong cây. |
| **Đổi tên** (<kbd>F2</kbd>), **Nhân bản** | Đổi tên hoặc sao chép tệp. |
| **Xóa** (<kbd>Delete</kbd>) | Xóa sau khi bạn xác nhận. |
| **Sao chép đường dẫn**, **Sao chép đường dẫn tương đối** | Sao chép đường dẫn. |
| **Mở trong tab** | Chuyển tệp thành tab riêng cạnh phiên của nó (cũng có thể bấm chuột giữa vào dòng). Xem [Khung & bố cục](/vi/features/panes#one-file-or-one-artifact-as-a-tab). |
| **Thêm vào prompt** | Chèn tệp vào hộp prompt dưới dạng @mention. |

## Phím {#keys}

| Phím | Ở đâu | Tác dụng |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Mọi nơi | Mở tệp theo tên. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> trong danh sách sẽ chèn `@path` vào prompt thay vì mở. |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Trình soạn thảo | Lưu |
| <kbd>Alt</kbd>+<kbd>K</kbd> | Trình soạn thảo | Chèn tệp và các dòng đã chọn vào hộp prompt (<kbd>⌥</kbd> <kbd>K</kbd> trên Mac) |
| <kbd>Ctrl</kbd>+<kbd>\\</kbd> | Mọi nơi | Hiện hoặc ẩn cây tệp |

## Cần biết {#good-to-know}

- Ảnh và video mở dưới dạng bản xem trước. Tệp SVG chuyển đổi được giữa xem trước và văn bản (**Hiện bản xem trước**).
- Nếu tệp thay đổi trên đĩa trong khi bạn đang sửa, bạn chọn: tải lại hoặc ghi đè.
- Trình duyệt cảnh báo trước khi bạn rời trang khi còn thay đổi chưa lưu.
- Chỉ mở được tệp nằm trong roots cho phép. Xem [`--roots`](/vi/reference/cli).

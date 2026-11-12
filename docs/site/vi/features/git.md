# Thao tác Git {#git-operations}

Commit, rollback, tạo nhánh, stash và xử lý xung đột mà không rời claude-code-ui. Các thao tác ghi nằm ở hai nơi: hộp commit của [Thay đổi](changes) và các menu nhánh, menu commit của [Đồ thị Git](git-graph). Chúng tác động lên kho mã đang chọn (xem [Kho mã](changes#repositories)).

![Khung Thay đổi với hộp commit](/screenshots/git.png)

## Commit {#commit}

Trong [Thay đổi](changes), chế độ **Chưa commit**, hộp commit nằm phía trên danh sách tệp.

1. Chọn các tệp cần commit: ô đứng trước một hàng, trước một thư mục, hoặc **Chọn tất cả tệp**. Bộ đếm hiển thị "2 / 5".
2. Nhập nội dung commit, hoặc bấm nút ngôi sao (**Tạo nội dung commit**): Claude viết nội dung cho các tệp đã chọn. **Dừng tạo** hủy việc đó.
3. Bấm **Commit** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>, <kbd>⌘</kbd> <kbd>↩</kbd> trên Mac), hoặc **Commit và Push**.

- Chỉ đúng các tệp đã chọn được commit, với nội dung hiện có trong work tree, bất kể phần đã staged. Các tệp staged khác giữ nguyên.
- **Sửa commit trước** (<kbd>Alt</kbd>+<kbd>M</kbd>) đưa nội dung commit của HEAD vào hộp và thay thế commit cuối. Tùy chọn này tắt trước commit đầu tiên. Bỏ chọn sẽ trả lại văn bản bạn đã gõ.
- **Commit và Push** push nhánh sau khi commit. Khi HEAD detached không có nhánh để push: commit vẫn được tạo và kết quả nói vì sao không push.
- Kết quả hiển thị "Đã commit *hash*".

### Chỉ dẫn viết nội dung commit {#commit-message-instruction}

**Tạo nội dung commit** hỏi Claude bằng một chỉ dẫn có sẵn. Đổi nó tại **Cài đặt › Git › Chỉ dẫn viết nội dung commit**. Cùng nhóm đó có **Chỉ dẫn viết nội dung commit cho** *dự án*, ưu tiên hơn cho dự án đó. Để trống: dùng chỉ dẫn có sẵn. Xem [Cài đặt › Git](../reference/settings#git).

## Rollback thay đổi {#roll-back-changes}

**Rollback** đưa tệp về commit gần nhất.

- Chọn các tệp rồi bấm **Rollback**, hoặc bấm chuột phải một hàng (nhấn giữ, <kbd>Shift</kbd>+<kbd>F10</kbd>) rồi chọn **Rollback…**.
- Hộp thoại **Rollback thay đổi** liệt kê các tệp. **Xóa bản sao cục bộ của tệp mới thêm** xóa luôn các tệp mới (mặc định tắt). Xác nhận bằng **Rollback**.
- **Rollback** một thay đổi riêng: trong diff của tệp văn bản đã sửa hoặc đã đổi tên, nút **Rollback** nằm sau mỗi khối thay đổi ("Rollback thay đổi này, dòng 12–18"). Nó chạy ngay, không hỏi.
- Mỗi tệp bị thay thế được lưu trước vào [Lịch sử cục bộ](timeline#local-history-file-timeline), nên **Khôi phục** đưa nó trở lại. Kết quả hiển thị "Đã rollback 2 tệp".

## Xung đột {#conflicts}

Khi merge, rebase, cherry-pick, revert hoặc áp dụng patch (`am`) dừng vì xung đột, hoặc có tệp chưa merge, một banner ở đầu Thay đổi nêu tên thao tác ("Đang merge") và liệt kê các tệp xung đột. Bấm một tệp để mở.

| Nút | Làm gì |
| --- | --- |
| **Nhờ Claude xử lý** | Đưa vào ô prompt một prompt nêu kho mã và các tệp xung đột, yêu cầu Claude sửa chúng và không chạy `git add`, `git commit` hay `--continue`. Bạn xem lại rồi gửi. |
| **Tiếp tục** | Tiếp tục thao tác. Với tệp chưa merge, nút là **Đánh dấu đã xử lý**. |
| **Hủy** | Bỏ thao tác và mọi chỗ đã xử lý, sau khi bạn xác nhận. Các tệp đã đổi được lưu trước vào Lịch sử cục bộ. |

Nếu bước tiếp theo lại dừng, banner vẫn còn và hiển thị "Dừng vì xung đột".

## Merge và rebase {#merge-and-rebase}

Mở menu nhánh của Đồ thị Git (popup nhánh, hoặc bấm chuột phải một nhãn nhánh): **Merge vào** *hiện tại*… và **Rebase** *hiện tại* **lên** *nhánh*…. Một hộp thoại cho biết điều sẽ xảy ra. Hủy thì không chạy gì. Xung đột làm thao tác dừng: xử lý ở Thay đổi (xem trên). Rebase ghi lại các commit của nhánh hiện tại.

Nhánh hiện tại không có mục Checkout, Merge hay Rebase. Một chặn tạm thời (ví dụ merge chưa xong) vô hiệu hóa mục đó và nói lý do.

## Nhánh mới {#new-branch}

**Nhánh mới…** (menu nhánh, menu commit, hoặc **Git: Nhánh mới…** trong [bảng lệnh](palette)) hỏi **Tên nhánh**. **Checkout** (mặc định bật) chuyển sang nhánh sau khi tạo. Nhánh tạo tại một commit lấy commit đó làm điểm bắt đầu.

## Checkout và Smart checkout {#checkout-and-smart-checkout}

**Checkout** trong menu nhánh chuyển nhánh ngay. Nhánh từ xa có mục **Checkout thành nhánh local mới**.

Khi thay đổi local sẽ bị ghi đè, git từ chối và một hộp thoại đề nghị **Smart checkout**: nó stash thay đổi của bạn, checkout nhánh rồi áp lại chúng. Trạng thái staged không được giữ. File chưa theo dõi nằm vướng chỉ bị từ chối. Nếu việc áp lại dừng vì xung đột, nhánh vẫn đã được checkout và xung đột hiển thị trong Thay đổi. **Git: Smart checkout…** trong bảng lệnh làm đúng việc này ngay từ đầu.

## Stash {#stashes}

Trong Đồ thị Git, nút bật **Stash** mở một dải với danh sách stash (`stash@{0}` và tiếp theo).

- **Stash thay đổi…** hỏi ghi chú (tùy chọn) và **Gồm cả file chưa theo dõi**.
- Mỗi hàng có **Apply**, **Pop** và **Drop**. **Drop** hỏi trước và lưu nội dung các tệp của mục bị drop vào Lịch sử cục bộ.
- Stash tạo trong terminal hiển thị sau khi **Làm mới**.

## Chú thích (blame) {#annotate-blame}

Trong trình soạn thảo của Tệp, với tệp nằm trong một kho mã, nút bật **Chú thích** hiển thị commit của từng dòng bên cạnh số dòng: hash ngắn, ngày và tác giả, một lần cho mỗi đoạn dòng liên tiếp. Dòng đã sửa hoặc thêm kể từ HEAD hiển thị "chưa commit". Mỗi dấu là một nút: nó mở [Đồ thị Git](git-graph) tại commit đó. Khi có thay đổi chưa lưu, nó hiển thị "Hãy lưu tệp để chú thích." Mặc định tắt và được giữ khi chuyển tab.

## Lệnh trong bảng lệnh {#commands-in-the-palette}

[Bảng lệnh](palette) liệt kê **Git: Rollback…**, **Git: Nhánh mới…**, **Git: Checkout…**, **Git: Smart checkout…**, **Git: Stash…**, **Git: Chú thích (Blame)**, **Git: Merge…** và **Git: Rebase…** trong một kho git. Chúng không có phím mặc định. Gán phím trong [Phím tắt](../reference/shortcuts).

## Cần biết {#good-to-know}

- Thao tác ghi git chạy `git` trên máy của daemon (hoặc trên [môi trường](wsl-docker)) cùng các hook của bạn, như trong terminal.
- Reset hard, Smart checkout, drop stash, Hủy và Rollback giữ nội dung bị thay thế của mỗi tệp trong Dòng thời gian của tệp, với lý do "Trước khi reset", "Trước khi checkout", "Trước khi xóa stash", "Trước khi hủy" hoặc "Trước khi hoàn tác". Tắt tại **Cài đặt › Lịch sử cục bộ**.
- Push, Pull, Fetch và các thao tác commit Hoàn tác, Revert, Cherry-pick và Reset nằm ở trang [Đồ thị Git](git-graph).

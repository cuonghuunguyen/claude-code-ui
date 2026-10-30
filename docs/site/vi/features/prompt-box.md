# Hộp prompt

Hộp ở cuối phiên. Bạn gõ prompt tại đây, và chọn model, chế độ và effort.

## Phím {#keys}

| Phím | Tác dụng |
| --- | --- |
| <kbd>Enter</kbd> | Gửi |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | Xuống dòng |
| <kbd>Enter</kbd> khi Claude đang làm việc | **Điều hướng (Steer)**: tin nhắn của bạn nhập vào lượt đang chạy ngay lập tức |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> khi Claude đang làm việc (<kbd>Option</kbd>+<kbd>Enter</kbd> trên Mac) | **Xếp hàng (Queue)**: tin nhắn của bạn chờ và bắt đầu lượt riêng khi Claude rảnh |
| <kbd>Esc</kbd> | Dừng lượt đang chạy (giống nút **Dừng**) |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | [Chế độ quyền](/vi/features/permissions) tiếp theo |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Nhảy đến hộp prompt từ mọi nơi |

Trong **Cài đặt > Chung > Gửi** bạn có thể hoán đổi hai phím: <kbd>Enter</kbd> xếp hàng và <kbd>Alt</kbd>+<kbd>Enter</kbd> điều hướng. Nút gửi theo cùng lựa chọn đó, và một gợi ý phía trên nó hiện các phím.

## Chế độ bash: `!` {#bash-mode}

1. Gõ `!` làm ký tự đầu tiên. Hộp chuyển thành dấu nhắc shell.
2. Gõ một lệnh, ví dụ `! npm test`, và nhấn <kbd>Enter</kbd>.
3. Lệnh chạy trong thư mục của phiên. Kết quả hiện trong dòng thời gian, và Claude thấy nó ở lượt tiếp theo.
4. **Dừng** kết thúc lệnh bị treo. Để giữ lệnh dài chạy tiếp trong khi bạn làm việc khác, bấm **Chạy nền** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>, xem [Shell nền](/vi/features/background-shells)).
5. <kbd>Esc</kbd> (hoặc <kbd>Backspace</kbd> trong hộp trống) thoát chế độ bash.

Khi Claude đang làm việc, lệnh `!` chờ trong hàng đợi như một tin nhắn và chạy khi phiên rảnh.

`!` cũng dùng được trong hộp của phiên mới: nó bắt đầu phiên và chạy lệnh.

## Lệnh slash: `/` {#slash-commands}

- Gõ `/` để liệt kê lệnh và skill. Chọn một mục bằng phím mũi tên và <kbd>Enter</kbd>. <kbd>Tab</kbd> chèn nó vào.
- Lệnh `/command` cũng dùng được giữa tin nhắn, như trong Claude Code.
- Một số lệnh mở hộp thoại thay vì được gửi: `/mcp`, `/skills` (hoặc `/help`), `/plugins`, `/resume`. Xem [MCP, skill & plugin](/vi/features/config-dialogs).
- `/clear` bắt đầu một phiên mới trong cùng tab.
- `/btw <question>` đặt một [câu hỏi bên lề](/vi/features/aside) trong cửa sổ nổi, kể cả khi Claude đang làm việc.
- `/tasks` (hoặc `/bashes`) mở danh sách [Shell nền](/vi/features/background-shells).

## Tệp và ảnh {#files-and-images}

- Gõ `@` và một phần tên tệp để nhắc đến tệp.
- Dán hoặc thả ảnh vào hộp, hoặc bấm **+** (**Thêm ảnh và tệp**). PNG, JPEG, GIF và WebP được gửi đến Claude dưới dạng ảnh.
- Các tệp khác được tải lên và thêm vào prompt dưới dạng đường dẫn.
- Văn bản dán lớn (hơn 800 ký tự hoặc hơn 2 dấu xuống dòng) hiện thành một khối `[Pasted text #1 +120 lines]` trong hộp và trong tin nhắn đã gửi. Bấm vào khối để đọc văn bản. Xóa nó như một ký tự (<kbd>Backspace</kbd>). Claude nhận toàn bộ văn bản. Nhiều lần dán được đánh số #1, #2…

## Bộ chọn dưới hộp {#pickers-under-the-box}

Chế độ quyền (xem [Quyền & chế độ](/vi/features/permissions)), model và mức effort suy nghĩ. Trên điện thoại chúng gộp thành một chip cài đặt.

## Cần biết {#good-to-know}

- Hàng định dạng phía trên hộp viết Markdown thuần. Các phím của nó nằm trên [trang phím tắt](/vi/reference/shortcuts#in-the-prompt-box).
- Những gì bạn gõ được lưu thành bản nháp trong trình duyệt này. Bản nháp còn sau khi tải lại. Ảnh không được lưu trong bản nháp.
- Vòng tròn cạnh nút gửi là đồng hồ ngữ cảnh. Xem [Mức dùng & ngữ cảnh](/vi/features/usage).

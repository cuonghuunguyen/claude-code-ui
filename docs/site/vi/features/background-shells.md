# Shell nền {#background-shells}

Một lệnh shell có thể chạy nền: lượt vẫn tiếp tục, lệnh tiếp tục chạy, và việc nó kết thúc được báo cho Claude.

## Chuyển một lệnh sang nền {#move-a-command-to-the-background}

- Trên thẻ của lệnh Bash đang chạy, bấm **Chạy nền**, hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (<kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>B</kbd> trên Mac) khi phiên đang chạy một lệnh. Thẻ trở thành thẻ shell nền. Thẻ của lệnh Bash do subagent chạy cũng có nút này.
- Lệnh `!` của [chế độ bash](prompt-box#bash-mode) có cùng nút.
- Khi Claude đang làm việc, lệnh `!` bạn nhập sẽ chờ trong hàng đợi như một tin nhắn và chạy khi phiên rảnh.

## Danh sách shell {#the-shells-list}

1. Bấm **N shell** trên thanh trạng thái dưới ô nhập prompt, chạy **Shell nền** trong [bảng lệnh](palette), hoặc nhập `/tasks` (hoặc `/bashes`) vào ô nhập prompt.
2. Danh sách hiển thị mọi shell của phiên, shell đang chạy ở trên, kèm lệnh, mô tả, trạng thái (đang chạy, đã hoàn tất, thất bại hoặc đã bị dừng) và thời gian chạy.
3. Mở một shell để đọc kết quả của nó. Kết quả cập nhật trực tiếp khi shell chạy. Shell khởi động trước `/clear` vẫn hiển thị kết quả.
4. **Dừng** kết thúc một shell đang chạy sau khi bạn xác nhận.

## Cần biết {#good-to-know}

- **Dừng** hoặc <kbd>Esc</kbd> dừng lượt, không dừng các shell nền.
- Shell đang chạy được tính là công việc: phiên hiển thị là đang làm việc, và không bị đóng vì rảnh.
- Claude biết về shell bạn đã dừng cưỡng bức qua tin nhắn tiếp theo của bạn.

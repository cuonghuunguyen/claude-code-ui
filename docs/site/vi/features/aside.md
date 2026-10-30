# Đặt câu hỏi bên lề {#ask-an-aside}

Đặt một câu hỏi bên lề về một phiên mà không ảnh hưởng đến phiên. **Câu hỏi bên lề** là một bản sao của phiên, biết mọi thứ cho đến thời điểm hiện tại. Nó trả lời trong một cửa sổ nổi trong khi phiên vẫn dùng được ở phía sau.

## Cách dùng {#how-to-use}

1. Trong một phiên, nhập `/btw` và câu hỏi của bạn vào ô nhập prompt, rồi nhấn <kbd>Enter</kbd>. Hoặc chạy **Đặt câu hỏi bên lề** trong [bảng lệnh](palette). Khi bảng quyền hoặc bảng câu hỏi thay thế ô nhập prompt, **Đặt câu hỏi bên lề** hiện một ô nhập một dòng.
2. Cửa sổ nổi mở ngay và bắt đầu trả lời. Nó có dòng thời gian riêng, ô nhập prompt cho các câu hỏi tiếp theo, và bảng quyền cùng bảng câu hỏi riêng.
3. Kéo cửa sổ bằng phần đầu, đổi kích thước bằng góc, hoặc bấm **Thu nhỏ câu hỏi bên lề** để gập nó thành một nhãn ở góc dưới bên phải.
4. **Đóng câu hỏi bên lề** xóa câu hỏi bên lề.
5. **Giữ làm phiên** biến nó thành một phiên bình thường: nó có tiêu đề trong thanh bên và mở thành một tab, còn cửa sổ nổi đóng lại.

## Cần biết {#good-to-know}

- Nó hoạt động trong khi Claude chạy một lượt. Lượt đó vẫn tiếp tục không bị ảnh hưởng. Câu hỏi bên lề thấy phiên đến câu trả lời hoàn chỉnh gần nhất, không thấy nội dung Claude đang viết. Phiên chưa có câu trả lời nào thì không thể đặt câu hỏi bên lề.
- Câu hỏi bên lề chỉ đọc: Edit, Write và NotebookEdit bị tắt, và nó không khởi động worker. Các công cụ khác chạy ở [chế độ](permissions) mặc định, nên Bash và các công cụ khác sẽ hỏi. Đổi chế độ quyền của nó sẽ bỏ giới hạn chỉ đọc.
- Yêu cầu của nó chỉ hiện trong cửa sổ nổi của nó, không bao giờ trong bảng của phiên. [Focus](focus) liệt kê chúng dưới dạng "Câu hỏi bên lề: *tiêu đề*"; **Mở** đưa cửa sổ nổi lên trước.
- Có thể mở nhiều cửa sổ nổi. Cửa sổ nổi chỉ hiện khi tab của phiên chứa nó đang hiện. Các cửa sổ nổi đang mở không được khôi phục sau khi tải lại trang.
- Trên điện thoại, cửa sổ nổi chiếm toàn màn hình.
- `/btw` và `/clear` không dùng được bên trong câu hỏi bên lề. Ảnh trong câu hỏi không được gửi.
- Câu hỏi bên lề không được giữ sẽ không được liệt kê và bị xóa khi không còn cần nữa, kể cả sau khi đóng trình duyệt hoặc khởi động lại, nên nó không hiện trong `claude --resume`.

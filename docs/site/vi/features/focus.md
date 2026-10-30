# Trang Focus

Một trang cho thấy, theo từng phiên, phiên nào cần bạn, phiên nào đang làm việc và phiên nào đã xong khi bạn vắng mặt. Yêu cầu được trả lời ngay tại đó.

![Trang Focus với hai phiên đang chờ, một phiên đang làm việc và hai phiên đã xong](/screenshots/focus.png)

## Cách dùng {#how-to-use}

1. Mở **Focus**: dòng ở đầu thanh bên, hoặc tab **Focus** được ghim. Con số cho biết có bao nhiêu phiên đang chờ câu trả lời.
2. **Cần bạn** liệt kê các yêu cầu, rồi đến các phiên cần xem qua. Chọn một dòng (bấm hoặc dùng phím mũi tên).
3. Trả lời yêu cầu ngay tại chỗ, giống như trong phiên: **Cho phép một lần**, **Luôn cho phép**, **Từ chối**, hoặc trả lời câu hỏi.
4. Bấm **Yêu cầu chờ kế tiếp** (hoặc <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>↓</kbd> từ mọi nơi) để nhảy đến yêu cầu kế tiếp.
5. **Đang chạy** cho thấy mỗi phiên đang chạy làm gì và, nếu có danh sách tác vụ, tiến độ của nó ("2 trên 5"). Bấm một dòng để mở phiên.
6. **Đã xong khi bạn vắng mặt** liệt kê các phiên đã kết thúc một lượt kể từ lần bạn xem gần nhất, với dòng cuối của câu trả lời và tóm tắt tác vụ.
7. Các dòng lỗi, im lặng, đã xong và đạt giới hạn mức dùng có một nút bên cạnh: **Mở phiên**, hoặc **Hủy tiếp tục** trên dòng đạt giới hạn mức dùng để dừng lần tiếp tục đã lên lịch.

## Cần biết {#good-to-know}

- Các dòng theo thứ tự cố định: đã chuyển lên, quyền, câu hỏi, lỗi, giới hạn mức dùng, im lặng. Phần đầu trang cho biết bao nhiêu phiên cần bạn, bao nhiêu phiên cần xem lại và bao nhiêu phiên đang làm việc.
- **Im lặng** là thông tin, không phải báo động: phiên đang chạy không có sự kiện nào trong 5 phút và không có công cụ nào đang chạy. Hãy kiểm tra, có thể vẫn bình thường.
- Mỗi danh sách hiện 5 dòng và **+N nữa**.
- Dòng lỗi và dòng đã xong biến mất khi bạn mở phiên. Dòng đã xong cũng biến mất sau 24 giờ.
- Con số trên tab và tiêu đề chỉ đếm các phiên đang chờ bạn (đã chuyển lên, quyền, câu hỏi).
- Dòng giới hạn mức dùng cũng hiện khi tự động tiếp tục đang tắt. Khi đó nó không có **Hủy tiếp tục**.
- Dòng của [worker](/vi/features/orchestration) được lồng dưới coordinator của nó.
- Dòng lỗi và dòng đã xong chưa đọc vẫn còn sau khi tải lại trang hoặc khởi động lại daemon.
- Chi tiết của một yêu cầu hiện công cụ và lệnh của nó một lần, trong thẻ yêu cầu.
- Yêu cầu đã trả lời thu nhỏ thành một dòng cho đến khi bạn rời trang.
- Mỗi yêu cầu có một **mức (tier)**. **Thấp** là thao tác đọc thông thường (hoặc, ở một số kho mã, một thao tác sửa) trong thư mục của phiên. Mọi thứ khác là **cao**. Yêu cầu mức cao hiện **Mức cao · luôn hỏi** và không có **Luôn cho phép** ở đây. Chỉ bạn trả lời được (xem [Điều phối](/vi/features/orchestration)).
- **Điều phối viên chuyển lên** đánh dấu yêu cầu của worker mà coordinator của nó đã chuyển cho bạn.
- Bạn cũng có thể mở trang bằng liên kết `#focus`.
- Focus cũng mở được khi bảng dưới đang phóng to. Bảng bên và bảng dưới vẫn giữ nguyên khi Focus hiện, nên hộp prompt không nhảy khi bạn chuyển giữa Focus và một phiên.
- Khi bật **Tiếp theo cho bạn** (xem [Cài đặt › Focus](/vi/reference/settings#focus)), dòng đã xong có một chip với prompt tiếp theo được dự đoán. Bấm vào chip để đưa văn bản vào hộp prompt của phiên đó.
- Khi Focus đang mở, [thông báo trong ứng dụng](/vi/features/notifications) cho các yêu cầu bị ẩn: bạn đã thấy chúng ở đây.

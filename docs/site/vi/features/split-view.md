# Chia màn hình {#split-view}

Hiển thị hai phiên cạnh nhau, hoặc phiên này phía trên phiên kia, mỗi phiên có dòng thời gian, ô nhập prompt và vị trí cuộn riêng. Một phiên cũng có thể nằm cạnh một [khung](panes) của nó: kế hoạch, terminal của dự án, một tệp hoặc một artifact. Cần cửa sổ rộng ít nhất 1024px.

![Hai phiên cạnh nhau](/screenshots/split-view.png)

## Cách dùng {#how-to-use}

1. Mở ít nhất hai tab phiên.
2. Nhấp chuột phải vào một tab phiên (nhấn giữ, hoặc <kbd>Shift</kbd>+<kbd>F10</kbd> trên tab) và chọn **Chia sang phải** hoặc **Chia xuống dưới**. Tab đó chuyển vào phần chia mới.
3. Bấm hoặc dùng phím Tab vào một phần chia để đặt nó thành phần đang hoạt động. Một viền mỏng đánh dấu phần đó.
4. Kéo thanh giữa các phần chia để đổi kích thước, hoặc chọn thanh rồi nhấn các phím mũi tên. Nhấp đúp vào thanh để quay về 50/50.
5. Để kết thúc chia, chạy **Gộp các khung** trong [bảng lệnh](palette). Phiên đang hoạt động được giữ lại.

Bạn cũng có thể kéo một tab vào vùng phiên và thả ở một cạnh để chia tại đó. **Chia sang phải**, **Chia xuống dưới** và thao tác kéo cũng dùng được với các tab Kế hoạch, Tệp, Terminal, tệp và artifact. Một phần chia luôn chứa ít nhất một phiên. Biểu đồ Git luôn chiếm toàn bộ vùng, và Thay đổi luôn nằm trong bảng của nó.

## Cần biết {#good-to-know}

- Bảng lệnh cũng có **Chia sang phải**, **Chia xuống dưới**, **Chuyển sang khung kế tiếp** và **Chuyển sang khung trước**. Gán phím cho chúng trong [Phím tắt](../reference/shortcuts).
- Phần chia đang hoạt động là phiên hiện tại: bảng bên, terminal, các lệnh trong bảng lệnh và <kbd>Esc</kbd> (dừng) đều theo nó.
- Cả hai phiên trên màn hình được tính là đã xem, nên không phiên nào hiện thẻ thông báo.
- Tab của phần chia còn lại có biểu tượng chia. Đóng nó sẽ kết thúc việc chia.
- Khi cửa sổ quá hẹp cho hai phần chia, mỗi lần chỉ hiện một phần, kèm nút **Đóng chia màn hình**. Phần chia trở lại khi đủ chỗ.
- Sau khi chia, tiêu điểm gõ phím nằm ở phần chia mới: gõ ngay được, kể cả trong terminal.
- Việc chia được lưu theo trình duyệt và khôi phục khi tải lại, miễn là cả hai tab còn mở.

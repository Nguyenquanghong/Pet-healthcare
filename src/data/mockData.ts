export const pets = [
  { id: "p1", name: "Mochi", breed: "Shiba Inu", age: "2 tuổi", status: "Khỏe mạnh", owner: "Nguyễn Văn A" },
  { id: "p2", name: "Sashimi", breed: "Scottish Fold", age: "1 tuổi", status: "Cần tiêm phòng", owner: "Trần Thị B" },
  { id: "p3", name: "Maximus", breed: "Golden Retriever", age: "4 tuổi", status: "Ổn định", owner: "Lê Minh C" },
];

export const appointments = [
  { time: "09:00", pet: "Mochi", service: "Khám tổng quát", doctor: "Bs. Mai Nguyễn", status: "Đã xác nhận" },
  { time: "10:30", pet: "Sashimi", service: "Tiêm phòng", doctor: "Dr. Kenji Sato", status: "Chờ xác nhận" },
  { time: "14:00", pet: "Maximus", service: "Dental Cleaning", doctor: "Bs. Trần Anh", status: "Đã check-in" },
];

export const records = [
  { date: "28/10/2026", pet: "Mochi", title: "Annual Checkup & Vaccination", note: "Sức khỏe ổn định, nhắc lịch tái khám sau 6 tháng." },
  { date: "14/10/2026", pet: "Maximus", title: "Dental Cleaning", note: "Làm sạch răng, kê gel chăm sóc nướu." },
  { date: "02/10/2026", pet: "Sashimi", title: "Dermatology Consult", note: "Theo dõi dị ứng thức ăn, tái khám nếu ngứa tăng." },
];

export const notifications = [
  "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.",
  "Sashimi cần tiêm phòng nhắc lại trong tuần này.",
  "Ưu đãi 20% dịch vụ Grooming & Spa cho khách hàng thành viên.",
];

export const bookings = [
  { pet: "Yuki", owner: "Nguyễn Văn A", dates: "10/11 - 13/11", room: "Deluxe Suite", total: 20100, status: "Chờ xác nhận" },
  { pet: "Mochi", owner: "Nguyễn Văn A", dates: "18/11 - 20/11", room: "Standard Cabin", total: 7600, status: "Đã xác nhận" },
];
# Transaction and ownership audit

- `backend/src/infrastructure/persistence/appointmentRepository.ts`: L51 return this.client.$transaction(async (tx) => work({
- `backend/src/infrastructure/persistence/bookingLifecycleRepository.ts`: L22 return this.client.$transaction(async tx => {; L23 if (kind === "appointment") await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;; L24 else await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;; L41 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoice.id} FOR UPDATE`;
- `backend/src/infrastructure/persistence/bootstrapRepository.ts`: L9 return this.client.$transaction(async tx => {
- `backend/src/infrastructure/persistence/hotelRepository.ts`: L24 await this.client.$queryRaw`SELECT id FROM pets WHERE id = ${id} FOR UPDATE`;; L27 await this.client.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;; L44 await this.client.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${data.bookingId} FOR UPDATE`;; L61 return this.client.$transaction(async (tx) => work({
- `backend/src/infrastructure/persistence/invoiceRepository.ts`: L23 return this.client.$transaction(async (tx) => {; L25 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;; L52 return await this.client.$transaction(async (tx) => work({; L55 await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;; L59 await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;; L77 return this.client.$transaction(async tx => {; L78 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;; L90 return this.client.$transaction(async tx => {; L91 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;; L104 return this.client.$transaction(async tx => {; L105 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;; L121 return this.client.$transaction(async tx => {; L122 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
- `backend/src/infrastructure/persistence/listsRepository.ts`: L15 return this.client.$transaction(async tx => {; L98 return this.client.$transaction(async tx => {
- `backend/src/infrastructure/persistence/medicalRepository.ts`: L20 await this.client.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;; L61 return this.client.$transaction(async (tx) => work({
- `backend/src/infrastructure/persistence/ownerActivationRepository.ts`: L16 return await this.client.$transaction(async client => {; L18 await client.$queryRaw`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`;
- `backend/src/infrastructure/persistence/paymentRepository.ts`: L16 return this.db.$transaction(async tx => {; L17 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;; L37 return await this.db.$transaction(async tx => {; L41 await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${candidate.invoiceId} FOR UPDATE`;
- `backend/src/infrastructure/persistence/publicRescueRepository.ts`: L26 return this.client.$transaction(async (tx) => work(new PrismaPublicRescueRepository(tx)));

- Appointment/medical completion + Notification: atomic today; split requires Clinic outbox.
- Invoice source lock + invoice + Notification: atomic today; appointment path requires reservation; hotel remains Core.
- Lifecycle checks medical/care/invoice under booking lock: undo must check Clinic reservation under the same appointment lock.
- Public rescue, hotel, activation, payment use local transactions; Notification producer replacements belong to P2.
- Lists/bootstrap join legacy domains: read inventory includes lists.ts before write routers; P3/P5 must split queries.
- Partial appointment slot index excludes cancelled/no_show for all types; invoice appointment/hotel unique constraints remain mandatory.
- API CSV caller/test columns are source candidates, not proof that every operation is covered.

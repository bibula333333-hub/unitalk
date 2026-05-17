// Общие функции для всего сайта

// Автоматическое скрытие алертов через 5 секунд
document.addEventListener('DOMContentLoaded', function() {
    const alerts = document.querySelectorAll('.alert');
    alerts.forEach(alert => {
        setTimeout(() => {
            alert.style.transition = 'opacity 0.5s';
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 500);
        }, 5000);
    });
});

// Функция для загрузки факультетов
async function loadFaculties(universityId, facultySelectId, selectedFacultyId = null) {
    const facultySelect = document.getElementById(facultySelectId);
    if (!facultySelect) return;
    
    facultySelect.innerHTML = '<option value="">Загрузка...</option>';
    
    if (universityId) {
        try {
            const response = await fetch(`/api/faculties/${universityId}`);
            const faculties = await response.json();
            facultySelect.innerHTML = '<option value="">Выберите факультет</option>';
            
            faculties.forEach(faculty => {
                const option = document.createElement('option');
                option.value = faculty.id;
                option.textContent = faculty.name;
                if (selectedFacultyId && faculty.id === selectedFacultyId) {
                    option.selected = true;
                }
                facultySelect.appendChild(option);
            });
        } catch (error) {
            console.error('Ошибка загрузки факультетов:', error);
            facultySelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    } else {
        facultySelect.innerHTML = '<option value="">Сначала выберите вуз</option>';
    }
}